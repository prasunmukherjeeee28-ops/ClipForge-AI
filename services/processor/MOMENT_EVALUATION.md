# Moment detector evaluation

This deterministic benchmark compares manually labelled highlight ranges with the processor's ranked moment candidates. It does not change detector scoring or claim that a high-scoring window is entertaining.

## Input format

Create a labels JSON file with manually reviewed timestamps (seconds from the start of the authorized source):

```json
{
  "highlights": [
    { "startSeconds": 125.0, "endSeconds": 151.5 },
    { "startSeconds": 482.0, "endSeconds": 509.0 }
  ]
}
```

Create a predictions JSON file from detector output. It accepts the candidate shape emitted by `MomentCandidate.as_dict()`:

```json
{
  "candidates": [
    { "startSeconds": 120.0, "endSeconds": 150.0, "score": 0.87 },
    { "startSeconds": 480.0, "endSeconds": 510.0, "score": 0.79 }
  ]
}
```

Only timestamps and score are used. Additional detector fields are ignored. Both arrays can also be supplied as top-level JSON arrays; labels may use the key `labels`, and predictions may use `predictions`.

## Run

From `services/processor` after installing development dependencies:

```bash
python -m clipforge_processor.evaluate_moments --labels /path/to/labels.json --predictions /path/to/predictions.json --k 3 --iou-threshold 0.3
```

The default evaluation is top 3 predictions with a temporal intersection-over-union (IoU) match threshold of 0.30. A prediction can match at most one labelled highlight, and each label can be matched at most once.

## Metrics

- **Precision@K:** matched predictions divided by K (not the number of predictions returned).
- **Recall@K:** matched labelled highlights divided by all labelled highlights.
- **Duplicate prediction rate@K:** share of selected predictions that overlap another selected prediction at or above the IoU threshold.
- **Boundary error:** mean absolute start and end timestamp error for matched pairs, in seconds. Unmatched items are not included.
- **Matches:** per-pair start error, end error and temporal IoU.

Matching uses augmenting paths to maximize the number of one-to-one matches above the IoU threshold. When multiple predictions compete for one label, higher-ranked predictions are considered first; a match may be reassigned when that allows another prediction to match a different label. Use the same IoU threshold and K when comparing detector versions. For a fair benchmark, label footage before inspecting detector output, use footage the account is authorized to process, and keep the same labelled set across runs. A benchmark score measures agreement with those annotations, not universal highlight quality.
