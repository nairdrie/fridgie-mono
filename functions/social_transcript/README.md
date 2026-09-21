# Social transcript compatibility function

The existing Google Cloud function remains named `transcribe_tiktok`, but accepts public TikTok and Instagram video links. New Fridgie recipe imports call the same provider directly from the main API; this function supports callers needing a transcript only.

- `POST` JSON `{ "url": "https://www.instagram.com/reel/SHORTCODE/" }`.
- `Authorization: Bearer <Firebase ID token>` from a registered, non-anonymous account is required.
- Success remains `200 text/plain`. Invalid/missing authentication returns 401; anonymous users receive 403. `OPTIONS` supports browser preflight.
- `SUPADATA_API_KEY` is injected from Secret Manager. Do not put a value in these source files.
- Provider work is bounded to 120 seconds and handles both immediate and queued results. The function retains its 1 GiB memory and 300-second platform timeout.

Run isolated contract tests without credentials:

```sh
python3 -m unittest discover -s functions/social_transcript -p 'test_*.py'
```

Deploy from the repository root after granting this function's existing runtime identity access to the named secret:

```sh
gcloud functions deploy transcribe_tiktok --gen2 \
  --project=grocerease-5abbb --region=us-central1 --runtime=python313 \
  --entry-point=transcribe_tiktok --source=functions/social_transcript \
  --memory=1GiB --timeout=300 \
  --update-secrets=SUPADATA_API_KEY=fridgie-supadata-api-key:1 \
  --remove-secrets=OPENAI_API_KEY
```

Source uploads must exclude macOS `._*` metadata and `__pycache__`. Existing service IAM/public invocation settings are preserved; Firebase authentication is enforced by the function itself.
