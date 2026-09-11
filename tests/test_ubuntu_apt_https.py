from pathlib import Path
import subprocess


def test_ubuntu_transport_repair_preserves_repository_identity_and_trust(tmp_path):
    script = Path(__file__).resolve().parents[1] / "docker/ubuntu-apt-https.sh"
    sources = tmp_path / "sources.list.d"
    sources.mkdir()
    legacy = tmp_path / "sources.list"
    modern = sources / "ubuntu.sources"
    untouched = sources / "custom.list"
    original_legacy = "deb [signed-by=/usr/share/keyrings/ubuntu.gpg] http://archive.ubuntu.com/ubuntu/ resolute main\n"
    original_modern = "Types: deb\nURIs: http://security.ubuntu.com/ubuntu\nSuites: resolute-security\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu.gpg\nTrusted: no\n"
    original_custom = "deb https://archive.ubuntu.com/ubuntu resolute main\ndeb http://mirror.example/ubuntu resolute main\ndeb http://archive.ubuntu.com/ubuntu-other resolute main\n"
    legacy.write_text(original_legacy)
    modern.write_text(original_modern)
    untouched.write_text(original_custom)
    for _iteration in range(2):
        subprocess.run(["sh", str(script), str(tmp_path)], check=True)
        assert legacy.read_text() == original_legacy.replace("http://archive.ubuntu.com", "https://archive.ubuntu.com")
        assert modern.read_text() == original_modern.replace("http://security.ubuntu.com", "https://security.ubuntu.com")
        assert untouched.read_text() == original_custom


def test_both_worker_stages_apply_the_transport_repair_before_apt():
    worker = (Path(__file__).resolve().parents[1] / "docker/Dockerfile.worker").read_text()
    assert worker.count("COPY docker/ubuntu-apt-https.sh /tmp/ubuntu-apt-https.sh") == 2
    assert worker.count("RUN sh /tmp/ubuntu-apt-https.sh && apt-get update") == 2
    assert "--allow-unauthenticated" not in worker
    assert "Verify-Peer=false" not in worker
