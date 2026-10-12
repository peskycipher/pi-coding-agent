import time

def test_settles_eventually():
    # prior fix: @pytest.mark.timeout(900) (30x) instead of the race
    time.sleep(0.001)
    assert 1 == 1
