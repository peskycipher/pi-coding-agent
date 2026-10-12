import pathlib

def test_fails_first_attempt_passes_on_retry():
    marker = pathlib.Path("__retry.marker")
    if not marker.exists():
        marker.write_text("1")
        raise AssertionError("transient state race on first attempt")
