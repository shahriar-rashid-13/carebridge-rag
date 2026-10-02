// Creates the 36 synthetic catalog doctors (scripts/catalog.mjs) as real CareBridge doctor accounts.
//
// Usage:
//   node scripts/seed-doctors.mjs            dry run: prints what would change, writes nothing
//   node scripts/seed-doctors.mjs --apply    creates missing accounts and syncs doctor rows to the catalog
//   node scripts/seed-doctors.mjs --remove   deletes seeded accounts that have no appointments;
//                                            seeded doctors with appointments are set to inactive instead
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env, plus SEED_DOCTOR_PASSWORD (min 8 chars)
// when accounts must be created. Accounts are matched by email (doc-001@example.com ... doc-036@example.com),
// so re-running never creates duplicates.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTORS, DAY_NAMES } from "./catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_BATCH = "catalog-doctors-v1";

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[key]) throw new Error(`${key} missing in .env`);
  }
  return env;
}

function emailFor(doctor) {
  return `${doctor.ref.toLowerCase()}@example.com`;
}

function bioFor(doctor) {
  const level = doctor.senior ? "Senior consultant" : "Consultant";
  const days = doctor.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${level} in ${doctor.specialization} with ${doctor.experienceYears} years of experience. ` +
    `Speaks ${doctor.languages}. Available ${days}.`;
}

function doctorRow(doctor) {
  return {
    specialization: doctor.specialization,
    consultation_fee: doctor.fee,
    available_days: doctor.days,
    slots: doctor.slots,
    status: "active",
    bio: bioFor(doctor),
    room: doctor.room,
  };
}

function client(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  return async function call(method, urlPath, body, extraHeaders = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${urlPath} failed (${res.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

async function listUsersByEmail(call) {
  const byEmail = new Map();
  for (let page = 1; ; page++) {
    const data = await call("GET", `/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = data.users ?? [];
    for (const user of users) if (user.email) byEmail.set(user.email.toLowerCase(), user);
    if (users.length < 1000) break;
  }
  return byEmail;
}

async function seed(call, env, apply) {
  const users = await listUsersByEmail(call);
  const missing = DOCTORS.filter((d) => !users.has(emailFor(d)));
  if (apply && missing.length > 0) {
    const password = env.SEED_DOCTOR_PASSWORD;
    if (!password || password.length < 8) {
      throw new Error("SEED_DOCTOR_PASSWORD (min 8 chars) missing in .env; it is needed to create accounts.");
    }
  }

  const counts = { created: 0, promoted: 0, inserted: 0, updated: 0, unchanged: 0 };
  for (const doctor of DOCTORS) {
    const email = emailFor(doctor);
    let user = users.get(email);
    const label = `${doctor.ref} ${doctor.name} (${doctor.specialization})`;

    if (!user) {
      console.log(`create   ${label} <${email}>`);
      if (!apply) continue;
      user = await call("POST", "/auth/v1/admin/users", {
        email,
        password: env.SEED_DOCTOR_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: doctor.name, catalog_ref: doctor.ref, seed_batch: SEED_BATCH },
      });
      counts.created++;
    }

    const [profile] = await call("GET", `/rest/v1/profiles?id=eq.${user.id}&select=id,role,full_name`);
    if (!profile) throw new Error(`No profile for ${email}; the handle_new_user trigger did not run.`);
    if (profile.role !== "doctor" && profile.role !== "patient") {
      throw new Error(`${email} has role ${profile.role}; refusing to change it.`);
    }
    if (profile.role !== "doctor" || profile.full_name !== doctor.name) {
      console.log(`promote  ${label}`);
      if (apply) {
        await call("PATCH", `/rest/v1/profiles?id=eq.${user.id}`, { role: "doctor", full_name: doctor.name });
        counts.promoted++;
      }
    }

    const wanted = doctorRow(doctor);
    const [existing] = await call(
      "GET",
      `/rest/v1/doctors?user_id=eq.${user.id}&select=id,specialization,consultation_fee,available_days,slots,status,bio,room`,
    );
    if (!existing) {
      console.log(`insert   ${label} fee ${wanted.consultation_fee}, ${wanted.room}`);
      if (apply) {
        await call("POST", "/rest/v1/doctors", { user_id: user.id, ...wanted }, { Prefer: "return=minimal" });
        counts.inserted++;
      }
    } else {
      const differs = Object.keys(wanted).some(
        (key) => JSON.stringify(key === "consultation_fee" ? Number(existing[key]) : existing[key]) !== JSON.stringify(wanted[key]),
      );
      if (differs) {
        console.log(`update   ${label}`);
        if (apply) {
          await call("PATCH", `/rest/v1/doctors?id=eq.${existing.id}`, wanted, { Prefer: "return=minimal" });
          counts.updated++;
        }
      } else {
        counts.unchanged++;
      }
    }
  }

  console.log(apply ? `\nDone: ${JSON.stringify(counts)}` : `\nDry run. ${missing.length} accounts to create. Re-run with --apply.`);
}

async function remove(call) {
  const users = await listUsersByEmail(call);
  for (const doctor of DOCTORS) {
    const user = users.get(emailFor(doctor));
    if (!user || user.user_metadata?.seed_batch !== SEED_BATCH) continue;
    const [row] = await call("GET", `/rest/v1/doctors?user_id=eq.${user.id}&select=id`);
    // Appointments, prescriptions and waitlist rows cascade-delete with the doctor, so keep doctors that have any.
    let inUse = false;
    if (row) {
      for (const table of ["appointments", "prescriptions", "waitlist"]) {
        const rows = await call("GET", `/rest/v1/${table}?doctor_id=eq.${row.id}&select=id&limit=1`);
        if (rows.length > 0) inUse = true;
      }
    }
    if (inUse) {
      console.log(`inactive ${doctor.ref} ${doctor.name} (has patient records)`);
      await call("PATCH", `/rest/v1/doctors?id=eq.${row.id}`, { status: "inactive" }, { Prefer: "return=minimal" });
    } else {
      console.log(`delete   ${doctor.ref} ${doctor.name}`);
      await call("DELETE", `/auth/v1/admin/users/${user.id}`);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const env = loadEnv();
  const call = client(env);
  if (args.has("--remove")) await remove(call);
  else await seed(call, env, args.has("--apply"));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
