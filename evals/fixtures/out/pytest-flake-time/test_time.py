import datetime, os
def test_fails_under_off_hours_clock_skew_only():
    raw = os.environ.get("FAKE_NOW")
    now = datetime.datetime.fromisoformat(raw) if raw else datetime.datetime.now()
    if now.hour < 5:
        raise AssertionError("time-dependent behavior (FAKE_NOW=%s)" % raw)
