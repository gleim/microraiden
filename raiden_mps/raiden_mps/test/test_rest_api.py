import pytest # noqa
from raiden_mps.test.utils.channel_manager import (
    BlockchainMock,
)

from raiden_mps.proxy.server_flask import PaywalledProxy
from raiden_mps.header import HTTPHeaders as header


def test_resources(init_contract_address, manager_state_path):
    app = PaywalledProxy(BlockchainMock(None, None))
    tc = app.app.test_client()

    rv = tc.get("/expensive/something")
    assert rv.status_code == 402

    headers = {
        header.BALANCE_SIGNATURE: "0x123456789="
    }
    rv = tc.get("/expensive/something", headers=headers)
    assert rv.status_code == 200

    rv = tc.get("/cm")
    assert rv.status_code == 200

    rv = tc.get("/cm/close")
    assert rv.status_code == 200

    rv = tc.get("/cm/admin")
    assert rv.status_code == 200
