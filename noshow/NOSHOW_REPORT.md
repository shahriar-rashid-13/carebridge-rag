# No-show prediction report

## Summary

Two models predict whether a patient will miss an appointment. Both are trained and tested on real, anonymised appointment data. With a tuned threshold, gradient boosting finds 68% of real no-shows. About 3 in 10 of its flags are correct. That is 1.7 times the 18.5% no-show base rate. The "predict nobody no-shows" baseline has 81.5% accuracy but finds zero no-shows, so accuracy alone is misleading here.

## Data

- Source: [Medical Appointment No Shows](https://www.kaggle.com/datasets/joniarroba/noshowappointments) on Kaggle (Joni Hoppen, CC BY-NC-SA 4.0). Public clinics in Vitória, Brazil, April to June 2016.
- The file is not committed. To reproduce, download it to `noshow/data/KaggleV2-May-2016.csv`, then run `python noshow/train.py`, or run all cells in `noshow/noshow.ipynb` for the same numbers with charts. `noshow/noshow.html` is a saved copy of the executed notebook.
- The data is used offline for model evaluation only. It is never loaded into the CareBridge database, which stays synthetic.
- Cleaning: 110,527 raw rows. 6 rows with an age below 0 or above 110 are dropped, plus 5 rows where the appointment is before the booking date. 110,516 rows remain.

## Features

These features have a matching field in CareBridge, so the same model could later drive a risk badge in the app:

| Feature | Meaning |
|---|---|
| `lead_days` | Days from booking to appointment |
| `same_day` | Booked for the same day |
| `weekday` | Day of the week of the appointment |
| `age`, `is_female` | Patient age and gender |
| `sms_received` | Reminder SMS sent |
| `scholarship` | Enrolled in the Bolsa Família welfare programme |
| `hypertension`, `diabetes`, `alcoholism`, `handicap` | Recorded conditions |
| `prior_appointments`, `prior_no_shows`, `prior_no_show_rate` | The patient's history on earlier days |

The neighbourhood column is left out because it is specific to Vitória and has no CareBridge equivalent.

## Method

- **No leakage from history.** The history features count only appointments on earlier days. Outcomes from the same day are unknown when the prediction is made, so they are excluded.
- **Split by time, not at random.** The model learns from older appointments and is tested on newer ones, as it would be used in practice.

| Set | Dates | Rows | No-show rate |
|---|---|---|---|
| Train | 2016-04-29 to 2016-05-19 | 63,529 | 20.9% |
| Validation | 2016-05-20 to 2016-05-31 | 20,538 | 20.1% |
| Test | 2016-06-01 to 2016-06-08 | 26,449 | 18.5% |

- **Models.** Logistic regression with standardised features, and gradient boosting (scikit-learn `HistGradientBoostingClassifier`, 300 trees, learning rate 0.05).
- **Threshold tuning.** Each model is first trained on the train set. The threshold with the best F1 on the validation set is chosen. The model is then refitted on train plus validation and scored once on the test set with that threshold.
- **Baselines.** "Nobody no-shows", and a simple rule: flag patients with at least one earlier no-show.

## Results (test set, 26,449 appointments)

| Model | Threshold | Accuracy | Precision | Recall | F1 | PR-AUC | ROC-AUC | Flagged |
|---|---|---|---|---|---|---|---|---|
| Baseline: nobody no-shows | - | 0.815 | 0.000 | 0.000 | 0.000 | - | - | 0.0% |
| Baseline: earlier no-show | - | 0.715 | 0.247 | 0.266 | 0.256 | - | - | 19.9% |
| Logistic regression | 0.5 | 0.814 | 0.453 | 0.046 | 0.083 | 0.334 | 0.724 | 1.9% |
| Logistic regression | 0.231 (tuned) | 0.607 | 0.290 | 0.782 | 0.423 | 0.334 | 0.724 | 49.7% |
| Gradient boosting | 0.5 | 0.816 | 0.522 | 0.038 | 0.071 | 0.349 | 0.735 | 1.4% |
| **Gradient boosting** | **0.246 (tuned)** | 0.658 | **0.307** | **0.679** | **0.423** | **0.349** | **0.735** | 40.8% |

A random model has a PR-AUC equal to the base rate, 0.185. Both models reach about 0.35, close to twice that.

Confusion matrix, gradient boosting with the tuned threshold:

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 14,085 | 7,482 |
| Actual no-show | 1,569 | 3,313 |

Confusion matrix, "nobody no-shows" baseline:

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 21,567 | 0 |
| Actual no-show | 4,882 | 0 |

All confusion matrices are in `results/tables.md`. Raw numbers are in `results/metrics.json`.

## What drives the prediction

Permutation importance for gradient boosting, measured as the drop in test PR-AUC when one feature is shuffled:

| Feature | PR-AUC drop |
|---|---|
| `lead_days` | 0.138 |
| `age` | 0.043 |
| `prior_no_show_rate` | 0.020 |
| `prior_no_shows` | 0.012 |
| `sms_received` | 0.008 |
| All others | below 0.004 |

Lead time dominates. Appointments booked far ahead are missed much more often:

| Lead time | Appointments | No-show rate | SMS sent |
|---|---|---|---|
| Same day | 38,561 | 4.6% | 0% |
| 1 to 2 days | 11,938 | 22.7% | 0% |
| 3 to 7 days | 20,245 | 25.0% | 57.0% |
| 8 to 30 days | 29,395 | 31.7% | 59.6% |
| Over 30 days | 10,377 | 33.0% | 61.8% |

In this dataset, no SMS reminder was sent for appointments booked 2 days or less ahead. So `sms_received` partly stands in for lead time. It does not show that reminders cause no-shows.

## Discussion

- **Why the threshold matters.** At the default 0.5 threshold, both models flag under 2% of appointments and miss over 95% of no-shows. No-shows are the minority class, so predicted probabilities rarely pass 0.5. Tuning the threshold to about 0.25 raises recall from 4% to 68%.
- **Which model.** Both reach the same F1. Gradient boosting has a slightly higher PR-AUC and flags fewer appointments (41% against 50%), so its flags are more precise. It is the recommended model.
- **How to use it.** With about 31% precision, a flag should trigger a cheap action, such as an extra reminder or a confirmation call. It should not trigger anything that penalises the patient, such as overbooking their slot or refusing a booking.
- **Choosing a different threshold.** The F1 threshold weighs precision and recall equally. A clinic with limited staff for calls can raise the threshold to flag fewer, higher-risk appointments.

## Limits

- The data comes from Brazil in 2016. Patient behaviour in Dhaka may differ, so the model should be retrained on CareBridge's own appointments once enough exist.
- The data covers only about six weeks of appointments, so most patients have little or no history. Over a longer period, history features would likely matter more.
- The dataset has no specialty, doctor or appointment time of day. These are known to affect no-shows.
- Performance is moderate (ROC-AUC 0.73). This is typical for this dataset and shows that no-shows are hard to predict from booking data alone.
