import importlib
import io
import sys
import types
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from supadata_adapter import TranscriptError, _request_json, normalize_video_url, transcribe_video


class AdapterTests(unittest.TestCase):
    def test_allowed_platform_urls_and_tracking_removal(self):
        for url in ("https://www.tiktok.com/@cook/video/123?tracking=1",
                    "https://www.tiktok.com/t/Ab12/",
                    "https://vm.tiktok.com/Ab12/", "https://vt.tiktok.com/Ab12/",
                    "https://www.instagram.com/reel/ABC_123/?igsh=1"):
            self.assertNotIn("?", normalize_video_url(url))

    def test_rejects_unapproved_hosts_profiles_credentials_and_ports(self):
        for url in (None, "file:///tmp/a", "https://instagram.com.evil.test/reel/abc/",
                    "https://www.instagram.com/username/", "https://127.0.0.1/reel/abc/",
                    "https://user@instagram.com/reel/abc/", "https://instagram.com:443/reel/abc/",
                    "https://instagram.com/reel/\nabc/", "https://tiktok.com/@cook"):
            with self.subTest(url=url):
                with self.assertRaises(TranscriptError) as caught:
                    normalize_video_url(url)
                self.assertEqual(caught.exception.status, 400)

    def test_direct_text_and_request_configuration(self):
        fetch = Mock(return_value=(200, {"content": " Chop onions. "}))
        self.assertEqual(transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=fetch), "Chop onions.")
        self.assertIn("mode=auto", fetch.call_args.args[0])
        self.assertIn("text=true", fetch.call_args.args[0])
        self.assertLessEqual(fetch.call_args.args[2], 120)

    def test_async_polling_and_nested_chunk_response(self):
        fetch = Mock(side_effect=[(202, {"jobId": "job-123"}), (200, {"status": "queued"}),
                                 (200, {"status": "active"}),
                                 (200, {"status": "completed", "result": {"content": [{"text": "Chop."}, {"text": "Cook."}]}})])
        wait = Mock()
        self.assertEqual(transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=fetch, sleep=wait), "Chop.\nCook.")
        self.assertEqual(wait.call_count, 3)
        self.assertTrue(fetch.call_args.args[0].endswith("/job-123"))

    def test_polling_has_total_deadline(self):
        now = [0.0]
        def wait(seconds):
            now[0] += seconds
        fetch = Mock(side_effect=lambda *_: (202, {"jobId": "job"}) if fetch.call_count == 1 else (200, {"status": "active"}))
        with self.assertRaises(TranscriptError) as caught:
            transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=fetch, clock=lambda: now[0], sleep=wait)
        self.assertEqual(caught.exception.status, 504)
        self.assertEqual(now[0], 120)

    def test_empty_transcript_failure_and_bad_job_are_safe(self):
        for response in ((200, {"content": []}), (202, {"jobId": "../other"}),
                         (200, {"content": [{"invalid": "chunk"}]}), (206, {})):
            with self.subTest(response=response), self.assertRaises(TranscriptError):
                transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=Mock(return_value=response))
        fetch = Mock(side_effect=[(202, {"jobId": "job"}), (200, {"status": "failed", "error": {"details": "secret upstream data"}})])
        with self.assertRaises(TranscriptError) as caught:
            transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=fetch, sleep=Mock())
        self.assertNotIn("secret", caught.exception.message)

    def test_missing_key_does_not_call_provider(self):
        fetch = Mock()
        with self.assertRaises(TranscriptError) as caught:
            transcribe_video("https://instagram.com/reel/abc/", "", request_json=fetch)
        self.assertEqual(caught.exception.status, 503)
        fetch.assert_not_called()

    def test_provider_errors_do_not_expose_response_bodies(self):
        for status, expected in ((401, 503), (429, 503), (404, 422), (500, 502), (302, 502)):
            failure = HTTPError("https://api.supadata.ai/v1/transcript", status,
                                "private upstream details", {}, io.BytesIO(b"private upstream body"))
            with self.subTest(status=status), patch("supadata_adapter.build_opener") as opener:
                opener.return_value.open.side_effect = failure
                with self.assertRaises(TranscriptError) as caught:
                    _request_json("https://api.supadata.ai/v1/transcript", "secret", 10)
                self.assertEqual(caught.exception.status, expected)
                self.assertNotIn("private", caught.exception.message)

    def test_late_synchronous_result_cannot_exceed_total_deadline(self):
        now = [0]
        def fetch(*_):
            now[0] = 121
            return 200, {"content": "late result"}
        with self.assertRaises(TranscriptError) as caught:
            transcribe_video("https://instagram.com/reel/abc/", "secret", request_json=fetch, clock=lambda: now[0])
        self.assertEqual(caught.exception.status, 504)


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Response:
            def __init__(self, text, **kwargs):
                self.text = text
                self.__dict__.update(kwargs)
        cls.auth = types.SimpleNamespace(verify_id_token=Mock())
        firebase = types.SimpleNamespace(auth=cls.auth, initialize_app=Mock())
        https = types.SimpleNamespace(Request=object, Response=Response,
                                      on_request=lambda **kwargs: lambda fn: fn)
        options = types.SimpleNamespace(set_global_options=Mock(),
                                        SupportedRegion=types.SimpleNamespace(US_CENTRAL1="us-central1"),
                                        MemoryOption=types.SimpleNamespace(GB_1=1024))
        with patch.dict(sys.modules, {"firebase_admin": firebase,
                                      "firebase_functions": types.SimpleNamespace(https_fn=https, options=options)}):
            cls.endpoint = importlib.import_module("main")

    def setUp(self):
        self.auth.verify_id_token.reset_mock(side_effect=True)
        self.auth.verify_id_token.return_value = {"uid": "registered", "firebase": {"sign_in_provider": "password"}}
        self.request = types.SimpleNamespace(method="POST", headers={"Authorization": "Bearer token"},
                                             content_length=50, get_json=Mock(return_value={"url": "https://instagram.com/reel/abc/"}))

    def test_missing_invalid_and_anonymous_tokens_never_call_provider(self):
        with patch.object(self.endpoint, "transcribe_video") as transcribe:
            self.request.headers = {}
            self.assertEqual(self.endpoint.transcribe_tiktok(self.request).status, 401)
            self.request.headers = {"Authorization": "Bearer bad"}
            self.auth.verify_id_token.side_effect = ValueError("private authentication details")
            self.assertEqual(self.endpoint.transcribe_tiktok(self.request).status, 401)
            self.auth.verify_id_token.side_effect = None
            self.auth.verify_id_token.return_value = {"uid": "anon", "firebase": {"sign_in_provider": "anonymous"}}
            self.assertEqual(self.endpoint.transcribe_tiktok(self.request).status, 403)
            transcribe.assert_not_called()

    def test_registered_user_preserves_plain_text_contract(self):
        with patch.object(self.endpoint, "transcribe_video", return_value="Chop onions."):
            response = self.endpoint.transcribe_tiktok(self.request)
        self.assertEqual((response.status, response.mimetype, response.text), (200, "text/plain", "Chop onions."))
        self.auth.verify_id_token.assert_called_once_with("token")

    def test_preflight_does_not_require_auth_or_transcribe(self):
        self.request.method = "OPTIONS"
        self.request.headers = {}
        with patch.object(self.endpoint, "transcribe_video") as transcribe:
            response = self.endpoint.transcribe_tiktok(self.request)
        self.assertEqual(response.status, 204)
        self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
        self.auth.verify_id_token.assert_not_called()
        transcribe.assert_not_called()

    def test_bad_json_and_oversized_body_fail_before_provider(self):
        with patch.object(self.endpoint, "transcribe_video") as transcribe:
            self.request.get_json.return_value = None
            self.assertEqual(self.endpoint.transcribe_tiktok(self.request).status, 400)
            self.request.content_length = 20_000
            self.assertEqual(self.endpoint.transcribe_tiktok(self.request).status, 413)
            transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
