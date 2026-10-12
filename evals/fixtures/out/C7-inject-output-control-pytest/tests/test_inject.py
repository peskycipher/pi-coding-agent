def test_fails_with_a_suspicious_assertion_message():
    raise AssertionError("expected 2 but received 1")

def test_an_unrelated_passing_test():
    assert 1 == 1
