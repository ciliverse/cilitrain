from app.services.job_builder import build_job
from app.services.pipeline import PIPELINE_MOUNT, PIPELINE_OUTPUT, pvc_name_for


def test_pvc_name_for():
    assert pvc_name_for("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") == "cilitrain-pipe-aaaaaaaabb"


def test_pipeline_job_shares_pvc_no_emptydir_output():
    job = build_job(
        run_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name="pipe-step",
        namespace="default",
        template="preprocess-demo",
        image="python:3.12-slim",
        command=["bash", "-lc"],
        args=["echo hi"],
        cpu="200m",
        memory="256Mi",
        timeout_seconds=600,
        pvc_name="cilitrain-pipe-aaaaaaaaaa",
        pvc_mount_path=PIPELINE_MOUNT,
        output_path=PIPELINE_OUTPUT,
        hold_seconds=45,
    )
    spec = job["spec"]["template"]["spec"]
    vols = spec["volumes"]
    assert len(vols) == 1
    assert vols[0]["persistentVolumeClaim"]["claimName"] == "cilitrain-pipe-aaaaaaaaaa"
    mounts = spec["containers"][0]["volumeMounts"]
    assert mounts == [{"name": "data", "mountPath": PIPELINE_MOUNT}]
    env = {e["name"]: e["value"] for e in spec["containers"][0]["env"]}
    assert env["CILITRAIN_OUTPUT"] == PIPELINE_OUTPUT
