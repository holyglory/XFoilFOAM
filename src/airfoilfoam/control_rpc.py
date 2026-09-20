from celery.app.control import Control
from kombu.pidbox import Mailbox


class SingleConnectionMailbox(Mailbox):
    def __init__(self, *args, **kwargs):
        kwargs["producer_pool"] = None
        super().__init__(*args, **kwargs)


class SingleConnectionControl(Control):
    Mailbox = SingleConnectionMailbox
