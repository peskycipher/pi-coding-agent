import os, urllib.request

def test_reaches_the_fixture_service():
    url = os.environ.get("SERVICE_URL", "http://127.0.0.1:59999/health")
    urllib.request.urlopen(url, timeout=1)
