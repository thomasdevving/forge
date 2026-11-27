from fastapi.testclient import TestClient

from forge_api.app import app

client = TestClient(app)

REQ = {
    "payoff": [[40.0, 650.0], [65.0, 650.0], [120.0, 1200.0]],
    "spot": 72.6, "tick_spacing": 64, "bucket_multiplier": 4, "n_each_side": 10,
    "borrowable": {str(t): 10**14 for t in range(-29000 // 256 * 256, -24000, 256)},
    "limits": {"base_holdings": 10, "quote_holdings": 2000, "premium_budget": 20, "max_legs": 8},
    "market": {"whirlpool": "w", "base_decimals": 9, "quote_decimals": 6},
}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["ok"]


def test_compile_store_fetch_verify_roundtrip():
    r = client.post("/compile", json=REQ)
    assert r.status_code == 200
    body = r.json()
    assert body["result"]["status"] == "ok"
    cert = body["certificate"]
    assert client.post("/verify", json=cert).json()["valid"]
    h = client.post("/certificates", json=cert).json()["hash"]
    assert client.get(f"/certificates/{h}").json()["hash"] == h
    ev = client.post("/evaluate", json={"certificate": cert, "prices": [50.0, 100.0]}).json()
    assert len(ev["fhat"]) == 2


def test_feasibility_reports_reasons_for_kink_at_spot():
    req = {**REQ, "payoff": [[40.0, 726.0], [72.6, 726.0], [120.0, 1200.0]], "tolerance": 0.5}
    r = client.post("/feasibility", json=req).json()
    assert r["status"] == "infeasible"
    assert any("current price" in x for x in r["reasons"])


def test_rejects_tampered_certificate_and_bad_input():
    cert = client.post("/compile", json=REQ).json()["certificate"]
    cert["construction"]["cash"] += 1
    assert client.post("/certificates", json=cert).status_code == 422
    assert client.get("/certificates/not-a-hash").status_code == 400
    bad = {**REQ, "payoff": [[50.0, 1.0], [40.0, 2.0]]}
    assert client.post("/compile", json=bad).status_code == 422
