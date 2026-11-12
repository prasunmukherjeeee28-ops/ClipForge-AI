from clipforge_processor.client import signed_headers


def test_signature_is_deterministic_for_exact_request_bytes() -> None:
    body = b'{"workerId":"worker-1"}'
    first = signed_headers(
        "a" * 40, "POST", "/internal/processor/claim", body,
        timestamp=1_800_000_000, nonce="a" * 32,
    )
    second = signed_headers(
        "a" * 40, "POST", "/internal/processor/claim", body,
        timestamp=1_800_000_000, nonce="a" * 32,
    )

    assert first == second
    assert first["X-Processor-Nonce"] == "a" * 32
    assert len(first["X-Processor-Signature"]) == 64


def test_signature_changes_when_body_changes() -> None:
    secret = "b" * 40
    first = signed_headers(
        secret, "POST", "/internal/processor/claim", b'{"workerId":"a"}',
        timestamp=1_800_000_000, nonce="a" * 32,
    )
    second = signed_headers(
        secret, "POST", "/internal/processor/claim", b'{"workerId":"b"}',
        timestamp=1_800_000_000, nonce="a" * 32,
    )

    assert first["X-Processor-Signature"] != second["X-Processor-Signature"]


def test_signature_changes_when_nonce_changes() -> None:
    first = signed_headers(
        "c" * 40, "POST", "/internal/processor/claim", b"{}",
        timestamp=1_800_000_000, nonce="a" * 32,
    )
    second = signed_headers(
        "c" * 40, "POST", "/internal/processor/claim", b"{}",
        timestamp=1_800_000_000, nonce="b" * 32,
    )

    assert first["X-Processor-Signature"] != second["X-Processor-Signature"]
    assert first["X-Processor-Nonce"] != second["X-Processor-Nonce"]


def test_signer_generates_a_fresh_nonce_for_each_request() -> None:
    first = signed_headers("d" * 40, "POST", "/internal/processor/ping", b"{}")
    second = signed_headers("d" * 40, "POST", "/internal/processor/ping", b"{}")

    assert first["X-Processor-Nonce"] != second["X-Processor-Nonce"]
    assert len(first["X-Processor-Nonce"]) == 32


def test_signer_rejects_invalid_explicit_nonce() -> None:
    import pytest

    with pytest.raises(ValueError):
        signed_headers(
            "e" * 40, "POST", "/internal/processor/ping", b"{}",
            timestamp=1_800_000_000, nonce="not-a-valid-nonce",
        )
