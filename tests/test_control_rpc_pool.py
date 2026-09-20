import os
from pathlib import Path
import subprocess
import sys

import pytest


BASELINE = """
import concurrent.futures,faulthandler,threading
from celery import Celery
from kombu.pidbox import Mailbox
import sys
count=int(sys.argv[1])
app=Celery('isolated-control-reproduction',broker='memory://',backend='cache+memory://')
app.conf.broker_pool_limit=count
original=Mailbox._publish
ready=threading.Barrier(count)
def publish(self,*args,**kwargs):
    ready.wait(timeout=2)
    print('outer_connection_held',flush=True)
    return original(self,*args,**kwargs)
Mailbox._publish=publish
faulthandler.dump_traceback_later(0.5)
with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
    list(executor.map(lambda _:app.control.broadcast('ping',reply=False),range(count)))
print('completed',flush=True)
"""


@pytest.mark.parametrize("connections", [1, 4])
def test_installed_default_control_reproduces_nested_pool_exhaustion(connections):
    with pytest.raises(subprocess.TimeoutExpired) as failed:
        subprocess.run([sys.executable, "-c", BASELINE, str(connections)],
                       capture_output=True, timeout=3, check=True)
    output = (failed.value.stdout or b"").decode()
    trace = (failed.value.stderr or b"").decode()
    assert output.count("outer_connection_held") == connections
    assert "completed" not in output
    assert "create_producer" in trace and "_acquire_connection" in trace
    assert "producer_or_acquire" in trace and "broadcast" in trace


FIXED = """
import concurrent.futures,json,threading
from airfoilfoam.celery_app import make_celery
from kombu.pidbox import Mailbox
import sys
count=int(sys.argv[1])
app=make_celery()
app.conf.update(broker_url='memory://',result_backend='cache+memory://',broker_pool_limit=count)
pool=app.pool
producer_pool=app.amqp.producer_pool
assert app.control.mailbox.producer_pool is None
assert producer_pool is app.amqp.producer_pool
assert pool.limit==count
original=Mailbox._publish
ready=threading.Barrier(count)
def publish(self,*args,**kwargs):
    ready.wait(timeout=2)
    return original(self,*args,**kwargs)
Mailbox._publish=publish
def controls(_):
    app.control.broadcast('ping',reply=False)
    return app.control.inspect(timeout=0.01).active_queues()
with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
    results=list(executor.map(controls,range(count)))
assert results==[None]*count
assert not pool._dirty
app.control._after_fork()
assert app.control.mailbox.producer_pool is None
Mailbox._publish=original
app.send_task('isolated-fixture-not-executed',args=[1])
assert not pool._dirty
print(json.dumps({'completed':count,'pool_limit':pool.limit,'ordinary_publisher_preserved':True}))
"""


@pytest.mark.parametrize("connections", [1, 4])
def test_application_control_uses_one_connection_without_weakening_task_pool(connections):
    environment = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
    result = subprocess.run([sys.executable, "-c", FIXED, str(connections)], env=environment,
                            capture_output=True, timeout=12, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"ordinary_publisher_preserved": true' in result.stdout


@pytest.mark.parametrize("field,value", [("job_id", "foreign"), ("execution_stopped", False),
                                        ("producer_stopped", False), ("namespace_verified", False),
                                        ("remaining", [1]), ("error", "unreadable"),
                                        ("ownership_basis", "recorded_execution_namespace")])
def test_native_stress_verifier_rejects_incomplete_or_wrong_stop_proof(field, value):
    from scripts.dev.verify_control_pool_native import validate_cancellation
    proof = {"job_id": "selected", "execution_stopped": True, "producer_stopped": True,
             "namespace_verified": True, "remaining": [], "error": None,
             "ownership_basis": "never_started_cancellation_fence"}
    result = {"job_id": "selected", "cancelled": True, "execution_stopped": True, "stop_proof": proof}
    assert validate_cancellation("selected", result) == proof
    proof[field] = value
    with pytest.raises(RuntimeError, match="complete stop proof"):
        validate_cancellation("selected", result)
