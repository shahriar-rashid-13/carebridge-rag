# How to run the no-show notebook

The notebook runs in the browser with Jupyter Notebook. This avoids interpreter problems in the editor's built-in notebook view.

## 1. Get the data

Download "Medical Appointment No Shows" from [Kaggle](https://www.kaggle.com/datasets/joniarroba/noshowappointments), unzip it, and put the CSV here:

```text
carebridge-rag/noshow/data/KaggleV2-May-2016.csv
```

The `data/` folder is gitignored, so the CSV is never committed.

## 2. Create the environment (first time only)

Open PowerShell in the `noshow` folder:

```powershell
cd C:\Users\Alif\Documents\InternAssignmentShahriar\carebridge-rag\noshow
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

- `(.venv)` must appear at the start of the prompt after the second command. If it does not, the packages install into the main Python instead.
- If PowerShell blocks `Activate.ps1`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then try again.
- Always use `pip install -r requirements.txt`. Without `-r`, pip looks for a package named "requirements.txt" and fails.
- The `.venv` folder is gitignored.

## 3. Run the notebook

```powershell
cd C:\Users\Alif\Documents\InternAssignmentShahriar\carebridge-rag\noshow
.\.venv\Scripts\Activate.ps1
jupyter notebook noshow.ipynb
```

A browser tab opens at `http://localhost:8888`. In the menu, choose **Run > Run All Cells**. The run takes about 30 seconds. The numbers match `NOSHOW_REPORT.md` and `python train.py`.

## 4. Save the results

- **Save the notebook with its outputs:** press `Ctrl+S`, or choose **File > Save**. The tables and charts are stored inside `noshow.ipynb`, so they show the next time it is opened, even without running it again.
- **Make a copy to share:** choose **File > Save and Export Notebook As > HTML**. The browser downloads `noshow.html`. Move it into this folder to replace the old copy. Anyone can open the HTML file in a browser without Python.
- **PDF:** open the HTML file in a browser and use **Print > Save as PDF**.

## 5. Stop Jupyter

Close the browser tab, then press `Ctrl+C` in the PowerShell window. Unsaved changes are lost, so save first.

## Files

| File | Purpose |
|---|---|
| `noshow.ipynb` | The notebook: data, models, results and charts |
| `noshow.html` | Saved copy of the executed notebook for sharing |
| `train.py` | Data loading, features and models; the notebook imports from it |
| `NOSHOW_REPORT.md` | Written report |
| `results/` | `metrics.json` and `tables.md` written by `python train.py` |
| `requirements.txt` | Packages for the notebook |
