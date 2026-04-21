import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.metrics import precision_recall_fscore_support

# ── Configuración ────────────────────────────────────────────────────────────
HORIZON_ENTRY        = 20     # días hábiles (~1 mes)
HORIZON_SIGNAL       = 30     # días hábiles (~6 semanas)
THRESHOLD_ENTRY      = 0.03   # +3% → buena entrada
THRESHOLD_SIGNAL_BUY  = 0.05  # +5% → Comprar
THRESHOLD_SIGNAL_SELL = -0.03 # -3% → Vender

TECH_FEATURES = ['dist_30d_low', 'dist_60d_low', 'dist_90d_low', 'momentum_5d']

FEATURE_LABELS = {
    'dist_30d_low': 'Dist. mínimo 30d',
    'dist_60d_low': 'Dist. mínimo 60d',
    'dist_90d_low': 'Dist. mínimo 90d',
    'momentum_5d':  'Momentum 5d',
}


def _build_features(closes: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame(index=closes.index)
    df['close']        = closes
    df['min_30d']      = closes.rolling(30).min()
    df['min_60d']      = closes.rolling(60).min()
    df['min_90d']      = closes.rolling(90).min()
    df['dist_30d_low'] = (closes / df['min_30d']) - 1
    df['dist_60d_low'] = (closes / df['min_60d']) - 1
    df['dist_90d_low'] = (closes / df['min_90d']) - 1
    df['momentum_5d']  = closes.pct_change(5)
    return df.dropna(subset=TECH_FEATURES)


def _current_feats(r: dict):
    p   = r.get('price')
    m30 = r.get('min_30d')
    m60 = r.get('min_60d')
    m90 = r.get('min_90d')
    c5  = r.get('close_5d')
    if not all([p, m30, m60, m90, c5]):
        return None
    return {
        'dist_30d_low': (p / m30) - 1,
        'dist_60d_low': (p / m60) - 1,
        'dist_90d_low': (p / m90) - 1,
        'momentum_5d':  (p / c5)  - 1,
    }


def _build_why(feats: dict) -> list:
    return [
        {'label': FEATURE_LABELS[f], 'value': round(feats[f] * 100, 1)}
        for f in TECH_FEATURES
    ]


def _cv_metrics(model_cls, model_params, X, y, pos_label) -> dict:
    """3-fold stratified CV + precision/recall/F1 on full train set."""
    try:
        cv = StratifiedKFold(n_splits=3, shuffle=True, random_state=42)
        base = model_cls(**model_params)
        scores = cross_val_score(base, X, y, cv=cv, scoring='accuracy', n_jobs=-1)
        acc_mean = round(float(scores.mean()), 3)
        acc_std  = round(float(scores.std()), 3)
    except Exception:
        acc_mean, acc_std = None, None

    try:
        final = model_cls(**model_params)
        final.fit(X, y)
        classes = sorted(y.unique().tolist())
        pos_idx = classes.index(pos_label) if pos_label in classes else 0
        p, r, f, _ = precision_recall_fscore_support(y, final.predict(X), labels=classes, zero_division=0)
        prec = round(float(p[pos_idx]), 3)
        rec  = round(float(r[pos_idx]), 3)
        f1   = round(float(f[pos_idx]), 3)
    except Exception:
        prec = rec = f1 = None

    return {
        'accuracy_cv':     acc_mean,
        'accuracy_cv_std': acc_std,
        'precision_buy':   prec,
        'recall_buy':      rec,
        'f1_buy':          f1,
    }


# ── Modelo 1: Entry Point Score (Random Forest) ──────────────────────────────

def run_entry_score(watchlist_data: list, closes_dict: dict) -> tuple:
    """
    closes_dict: {ticker: pd.Series con DatetimeIndex}
    Retorna (results_list, metrics_dict)
    """
    all_X, all_y = [], []
    for _, closes in closes_dict.items():
        if len(closes) < 100:
            continue
        df = _build_features(closes)
        future_ret = closes.shift(-HORIZON_ENTRY) / closes - 1
        label      = (future_ret > THRESHOLD_ENTRY).astype(int)
        combined   = pd.concat([df[TECH_FEATURES], label.rename('label')], axis=1).dropna()
        if len(combined) < 20:
            continue
        all_X.append(combined[TECH_FEATURES])
        all_y.append(combined['label'])

    if not all_X:
        raise ValueError("No hay suficientes datos históricos para entrenar.")

    X = pd.concat(all_X)
    y = pd.concat(all_y)

    params = dict(n_estimators=200, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    metrics = _cv_metrics(RandomForestClassifier, params, X, y, pos_label=1)
    metrics['n_train']      = int(len(y))
    metrics['pct_positive'] = round(float(y.mean()), 3)

    model = RandomForestClassifier(**params)
    model.fit(X, y)

    results = []
    for r in watchlist_data:
        feats = _current_feats(r)
        if feats is None:
            continue
        try:
            X_curr = pd.DataFrame([feats])[TECH_FEATURES]
            prob   = float(model.predict_proba(X_curr)[0][1])
            results.append({
                'ticker':       r['ticker'],
                'company_name': r.get('company_name', r['ticker']),
                'score':        round(prob * 100, 1),
                'why':          _build_why(feats),
            })
        except Exception as e:
            print(f"ml entry_score {r.get('ticker')}: {e}")

    results.sort(key=lambda x: x['score'], reverse=True)
    return results, metrics


# ── Modelo 2: Señal de Posición (Logistic Regression) ───────────────────────

_SIGNAL_LABELS = {0: 'Vender', 1: 'Mantener', 2: 'Comprar'}
_SIGNAL_KEYS   = {0: 'sell',   1: 'hold',     2: 'buy'}


def _classify(ret):
    if pd.isna(ret):
        return np.nan
    if ret > THRESHOLD_SIGNAL_BUY:
        return 2
    if ret < THRESHOLD_SIGNAL_SELL:
        return 0
    return 1


def run_signal(watchlist_data: list, closes_dict: dict) -> tuple:
    """
    closes_dict: {ticker: pd.Series con DatetimeIndex}
    Retorna (results_list, metrics_dict)
    """
    all_X, all_y = [], []
    for _, closes in closes_dict.items():
        if len(closes) < 100:
            continue
        df         = _build_features(closes)
        future_ret = closes.shift(-HORIZON_SIGNAL) / closes - 1
        label      = future_ret.apply(_classify)
        combined   = pd.concat([df[TECH_FEATURES], label.rename('label')], axis=1).dropna()
        if len(combined) < 20 or combined['label'].nunique() < 2:
            continue
        all_X.append(combined[TECH_FEATURES])
        all_y.append(combined['label'])

    if not all_X:
        raise ValueError("No hay suficientes datos históricos para entrenar.")

    X = pd.concat(all_X)
    y = pd.concat(all_y)

    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    y_series = pd.Series(y.values)

    params  = dict(max_iter=1000, random_state=42, C=0.5, solver='lbfgs')
    metrics = _cv_metrics(LogisticRegression, params, X_scaled, y_series, pos_label=2)
    metrics['n_train']      = int(len(y))
    metrics['pct_positive'] = round(float((y == 2).mean()), 3)

    model = LogisticRegression(**params)
    model.fit(X_scaled, y)

    results = []
    for r in watchlist_data:
        feats = _current_feats(r)
        if feats is None:
            continue
        try:
            X_curr        = np.array([[feats[f] for f in TECH_FEATURES]])
            X_curr_scaled = scaler.transform(X_curr)
            probs         = model.predict_proba(X_curr_scaled)[0]
            classes       = model.classes_.tolist()
            pred_class    = classes[int(np.argmax(probs))]
            confidence    = round(float(np.max(probs)) * 100, 1)

            why = _build_why(feats)
            rec = r.get('recommendation', '')
            if rec and rec != '—':
                why.append({'label': 'Recomendación analistas', 'value': rec})

            results.append({
                'ticker':       r['ticker'],
                'company_name': r.get('company_name', r['ticker']),
                'signal':       _SIGNAL_LABELS[int(pred_class)],
                'signal_key':   _SIGNAL_KEYS[int(pred_class)],
                'confidence':   confidence,
                'probs':        {_SIGNAL_LABELS[c]: round(float(p) * 100, 1) for c, p in zip(classes, probs)},
                'why':          why,
            })
        except Exception as e:
            print(f"ml signal {r.get('ticker')}: {e}")

    return results, metrics
