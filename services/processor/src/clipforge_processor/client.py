from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Any

import httpx


def signed_headers(
    secret: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Sign the exact bytes sent to the Worker API with a one-time nonce."""
    stamp = str(timestamp if timestamp is not None else int(time.time()))
    request_nonce = nonce or secrets.token_hex(16)
    if len(request_nonce) != 32 or any(char not in "0123456789abcdefABCDEF" for char in request_nonce):
        raise ValueError("nonce must be 32 hexadecimal characters")
    request_nonce = request_nonce.lower()
    canonical = b"\n".join(
        [
            stamp.encode("ascii"),
            request_nonce.encode("ascii"),
            method.upper().encode("ascii"),
            path.encode("utf-8"),
            body,
        ]
    )
    signature = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "X-Processor-Timestamp": stamp,
        "X-Processor-Nonce": request_nonce,
        "X-Processor-Signature": signature,
    }


class ProcessorClient:
    def __init__(
        self,
        base_url: str,
        secret: str,
        timeout_seconds: float = 20,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._http = httpx.AsyncClient(timeout=timeout_seconds)

    async def close(self) -> None:
        await self._http.aclose()

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = signed_headers(self._secret, "POST", path, body)
        response = await self._http.post(
            f"{self._base_url}{path}",
            content=body,
            headers=headers,
        )
        response.raise_for_status()
        return response.json()

    async def ping(self) -> dict[str, Any]:
        return await self.post("/internal/processor/ping", {})

    async def claim(self, worker_id: str) -> dict[str, Any]:
        return await self.post("/internal/processor/claim", {"workerId": worker_id})

    async def heartbeat(self, job_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/heartbeat",
            {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token},
        )

    async def report_progress(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        stage: str,
        progress: int,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/progress",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "stage": stage,
                "progress": progress,
            },
        )

    async def complete(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": job_id,
            "leaseId": lease_id,
            "leaseToken": lease_token,
        }
        if title is not None:
            payload["title"] = title
        return await self.post("/internal/processor/complete", payload)

    async def fail(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        error_code: str,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/fail",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "errorCode": error_code,
            },
        )

    async def release(self, job_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/release",
            {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token},
        )
