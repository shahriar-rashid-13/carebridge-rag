| Model | Threshold | Accuracy | Precision | Recall | F1 | PR-AUC | ROC-AUC | Flagged |
|---|---|---|---|---|---|---|---|---|
| Baseline: nobody no-shows | - | 0.815 | 0.000 | 0.000 | 0.000 | - | - | 0.0% |
| Baseline: earlier no-show | - | 0.715 | 0.247 | 0.266 | 0.256 | - | - | 19.9% |
| Logistic regression (0.5) | 0.5 | 0.814 | 0.453 | 0.046 | 0.083 | 0.334 | 0.724 | 1.9% |
| Logistic regression (tuned) | 0.2306 | 0.607 | 0.290 | 0.782 | 0.423 | 0.334 | 0.724 | 49.7% |
| Gradient boosting (0.5) | 0.5 | 0.816 | 0.522 | 0.038 | 0.071 | 0.349 | 0.735 | 1.4% |
| Gradient boosting (tuned) | 0.2459 | 0.658 | 0.307 | 0.679 | 0.423 | 0.349 | 0.735 | 40.8% |

Confusion matrices on the test set (rows: actual, columns: predicted):

**Baseline: nobody no-shows**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 21567 | 0 |
| Actual no-show | 4882 | 0 |

**Baseline: earlier no-show**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 17606 | 3961 |
| Actual no-show | 3583 | 1299 |

**Logistic regression (0.5)**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 21298 | 269 |
| Actual no-show | 4659 | 223 |

**Logistic regression (tuned)**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 12230 | 9337 |
| Actual no-show | 1065 | 3817 |

**Gradient boosting (0.5)**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 21396 | 171 |
| Actual no-show | 4695 | 187 |

**Gradient boosting (tuned)**

| | Predicted show | Predicted no-show |
|---|---|---|
| Actual show | 14085 | 7482 |
| Actual no-show | 1569 | 3313 |

Permutation importance (drop in PR-AUC on the test set, gradient boosting):

| Feature | PR-AUC drop |
|---|---|
| lead_days | 0.1376 |
| age | 0.0427 |
| prior_no_show_rate | 0.0195 |
| prior_no_shows | 0.0119 |
| sms_received | 0.0081 |
| alcoholism | 0.0035 |
| scholarship | 0.0031 |
| prior_appointments | 0.0025 |
| is_female | 0.0023 |
| weekday | 0.0020 |
| hypertension | 0.0014 |
| diabetes | 0.0005 |
| same_day | -0.0001 |
| handicap | -0.0001 |
