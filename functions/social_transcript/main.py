"""Protected compatibility endpoint: POST {url} -> plain-text transcript."""

import logging
import os

from firebase_admin import auth, initialize_app
from firebase_functions import https_fn, options

from supadata_adapter import TranscriptError, transcribe_video

initialize_app()
options.set_global_options(region=options.SupportedRegion.US_CENTRAL1)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "no-store",
}


def _response(text, status=200):
    return https_fn.Response(text, status=status, mimetype="text/plain", headers=CORS_HEADERS)


@https_fn.on_request(secrets=["SUPADATA_API_KEY"], memory=options.MemoryOption.GB_1, timeout_sec=300)
def transcribe_tiktok(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        return _response("", 204)
    if req.method != "POST":
        return _response("Use POST with a JSON video URL.", 405)

    authorization = req.headers.get("Authorization", "").split()
    if len(authorization) != 2 or authorization[0].lower() != "bearer":
        return _response("Sign in to transcribe a video.", 401)
    try:
        claims = auth.verify_id_token(authorization[1])
        if not claims.get("uid"):
            return _response("Sign in to transcribe a video.", 401)
    except Exception:
        return _response("Sign in to transcribe a video.", 401)
    if claims.get("firebase", {}).get("sign_in_provider") == "anonymous":
        return _response("Create an account to use this feature.", 403)

    if req.content_length is not None and req.content_length > 16_384:
        return _response("Request body is too large.", 413)
    payload = req.get_json(silent=True)
    if not isinstance(payload, dict):
        return _response("Provide a JSON object containing a video URL.", 400)
    try:
        return _response(transcribe_video(payload.get("url"), os.environ.get("SUPADATA_API_KEY", "")))
    except TranscriptError as error:
        logging.warning("Social transcription failed: %s", error.code)
        return _response(error.message, error.status)
    except Exception:
        logging.error("Unexpected social transcription failure")
        return _response("Could not transcribe this video. Please try again.", 500)
