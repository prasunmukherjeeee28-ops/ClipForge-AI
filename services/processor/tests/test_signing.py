from clipforge_processor.client import signed_headers


def test_signature_is_deterministic_for_exact_request_bytes() -> None:
    body = b'{"workerId":"worker-1"}'
    first = signed_headers("a" * 40, "POST", "/internal/processor/claim", body, timestamp=1_800_000_000)
    second = signed_headers("a" * 40, "POST", "/internal/processor/claim", body, timestamp=1_800_000_000)

    assert first == second
    assert len(first["X-Processor-Signature"]) == 64


def test_signature_changes_when_body_changes() -> None:
    secret = "b" * 40
    first = signed_headers(secret, "POST", "/internal/processor/claim", b'{"workerId":"a"}', timestamp=1_800_000_000)
    second = signed_headers(secret, "POST", "/internal/processor/claim", b'{"workerId":"b"}', timestamp=1_800_000_000)

    assert first["X-Processor-Signature"] != second["X-Processor-Signature"]
