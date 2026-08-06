from app.services.cilikube import build_cilikube_links, job_deep_link, primary_cilikube_url


def test_job_path_matches_cilikube_spa():
    links = build_cilikube_links(
        "https://ck.example.com/",
        namespace="ml",
        job_name="cilitrain-abc",
        pod_name="cilitrain-abc-xyz",
        pvc_name="cilitrain-pipe-1",
    )
    assert links["configured"] is True
    assert links["console"] == "https://ck.example.com/overview"
    assert links["job"] == "https://ck.example.com/jobs/ml/cilitrain-abc"
    assert links["pod"] == "https://ck.example.com/pods/ml/cilitrain-abc-xyz"
    assert links["events"] == "https://ck.example.com/events"
    assert links["pvc"] == "https://ck.example.com/persistentvolumeclaims/ml/cilitrain-pipe-1"
    assert "/workloads/" not in links["job"]


def test_no_base_unconfigured():
    links = build_cilikube_links(None, namespace="default", job_name="j1")
    assert links["configured"] is False
    assert links["job"] is None
    assert primary_cilikube_url(links) is None


def test_job_without_pod():
    links = build_cilikube_links("http://localhost:5173", namespace="default", job_name="j1")
    assert links["job"] == "http://localhost:5173/jobs/default/j1"
    assert links["pod"] is None
    assert primary_cilikube_url(links) == links["job"]


def test_console_when_no_job_name():
    links = build_cilikube_links("https://ck.example", namespace="default")
    assert links["job"] is None
    assert primary_cilikube_url(links) == "https://ck.example/overview"


def test_job_deep_link_compat():
    assert job_deep_link("https://ck.example", "ns", "job-a") == "https://ck.example/jobs/ns/job-a"
    assert job_deep_link(None, "ns", "job-a") is None
    assert job_deep_link("https://ck.example", "ns", "") is None
