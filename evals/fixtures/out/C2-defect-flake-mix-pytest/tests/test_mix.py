import os

def test_passes_alpha():
    assert 1 == 1

def test_passes_beta():
    assert 2 == 2

def test_deterministic_defect():
    assert 1 + 1 == 3

def test_seeded_flake():
    seed = int(os.environ.get("TEST_SEED", "7"))
    if seed % 5 == 2:
        raise AssertionError("seeded nondeterminism, seed=%d" % seed)
