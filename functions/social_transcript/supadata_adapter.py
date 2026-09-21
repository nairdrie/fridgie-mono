"""Bounded Supadata transport; no media download or platform credentials."""

import json
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

API_ROOT = "https://api.supadata.ai/v1/transcript"
MAX_RESPONSE_BYTES = 1_000_000
MAX_TRANSCRIPT_CHARS = 100_000
TOTAL_TIMEOUT_SECONDS = 120


class TranscriptError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def normalize_video_url(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise TranscriptError("invalid_url", "Provide a public TikTok or Instagram video URL.", 400)
    value = value.strip()
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if (parsed.scheme not in ("http", "https") or parsed.username or parsed.password
                or parsed.port is not None or re.search(r"[\x00-\x20\\]", value)):
            raise ValueError()
        path = parsed.path
        valid = False
        if host in ("tiktok.com", "www.tiktok.com", "m.tiktok.com"):
            valid = bool(re.fullmatch(r"/(?:@[A-Za-z0-9_.-]+/video/[0-9]+|t/[A-Za-z0-9_-]+)/?", path))
        elif host in ("vm.tiktok.com", "vt.tiktok.com"):
            valid = bool(re.fullmatch(r"/[A-Za-z0-9_-]+/?", path))
        elif host in ("instagram.com", "www.instagram.com", "m.instagram.com"):
            valid = bool(re.fullmatch(r"/(?:reel|reels|p)/[A-Za-z0-9_-]+/?", path))
        if not valid:
            raise ValueError()
    except ValueError:
        raise TranscriptError("invalid_url", "Provide a public TikTok or Instagram video URL.", 400)
    # Tracking parameters are unnecessary for canonical public posts.
    return urlunsplit(("https", host, path, "", ""))


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the provider key to a redirect destination.
        return None


def _request_json(url, api_key, timeout):
    request = Request(url, headers={"x-api-key": api_key, "Accept": "application/json"})
    try:
        with build_opener(_NoRedirects()).open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except HTTPError as error:
        status = error.code
        error.close()
        if status in (401, 402, 429):
            raise TranscriptError("provider_unavailable", "Transcription is temporarily unavailable.", 503)
        if status in (403, 404):
            raise TranscriptError("video_unavailable", "This video is unavailable or requires sign-in.", 422)
        raise TranscriptError("provider_error", "Could not transcribe this video. Please try again.")
    except (TimeoutError, URLError, OSError):
        raise TranscriptError("provider_unavailable", "Transcription is temporarily unavailable.", 503)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise TranscriptError("invalid_response", "The transcription response was too large.")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
    if not isinstance(payload, dict):
        raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
    return status, payload


def _transcript_text(payload):
    result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    content = result.get("content")
    if isinstance(content, list):
        if any(not isinstance(chunk, dict) or not isinstance(chunk.get("text"), str) for chunk in content):
            raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
        content = "\n".join(chunk["text"] for chunk in content)
    if not isinstance(content, str):
        raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
    text = content.strip()
    if not text:
        raise TranscriptError("no_speech", "No spoken words were found in this video.", 422)
    if len(text) > MAX_TRANSCRIPT_CHARS:
        raise TranscriptError("invalid_response", "The transcript was too large.")
    return text


def transcribe_video(video_url, api_key, *, request_json=_request_json,
                     clock=time.monotonic, sleep=time.sleep):
    video_url = normalize_video_url(video_url)
    if not api_key or not api_key.strip():
        raise TranscriptError("not_configured", "Transcription is temporarily unavailable.", 503)
    deadline = clock() + TOTAL_TIMEOUT_SECONDS

    def fetch(url):
        remaining = deadline - clock()
        if remaining <= 0:
            raise TranscriptError("timeout", "Transcription took too long. Please try again.", 504)
        response = request_json(url, api_key.strip(), min(remaining, 105))
        if clock() >= deadline:
            raise TranscriptError("timeout", "Transcription took too long. Please try again.", 504)
        return response

    query = urlencode({"url": video_url, "text": "true", "mode": "auto"})
    status, payload = fetch(API_ROOT + "?" + query)
    if status == 200:
        return _transcript_text(payload)
    if status == 206:
        raise TranscriptError("no_transcript", "No transcript is available for this video.", 422)
    job_id = payload.get("jobId")
    if status != 202 or not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
    while True:
        sleep(max(0, min(1, deadline - clock())))
        status, payload = fetch(API_ROOT + "/" + job_id)
        if status != 200:
            raise TranscriptError("provider_error", "Could not transcribe this video. Please try again.")
        state = payload.get("status")
        if state == "completed":
            return _transcript_text(payload)
        if state == "failed":
            raise TranscriptError("provider_error", "Could not transcribe this video. Please try again.")
        if state not in ("queued", "active"):
            raise TranscriptError("invalid_response", "The transcription service returned an invalid response.")
