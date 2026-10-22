"""Persistent WebSocket connection to the epson-projector-broker.

Push-based from Home Assistant's side: the broker sends a full "state" snapshot on
connect and a "patch" (shallow top-level diff) on every change. The broker is the only
thing that talks to the projector (PJLink polling plus class 2 notifications), so Home
Assistant never adds protocol traffic of its own -- which matters on a projector whose
network control has been seen to fall over under load.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

RECONNECT_INITIAL_S = 1
RECONNECT_MAX_S = 30
WS_HEARTBEAT_S = 30


class EpsonBrokerHub(DataUpdateCoordinator[dict]):
    """Owns the persistent /ws connection and the latest broker state snapshot."""

    def __init__(self, hass: HomeAssistant, host: str, port: int, token: str | None) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN)
        self.host = host
        self.port = port
        self.token = token
        self.data: dict = {}

        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False
        self._backoff = RECONNECT_INITIAL_S
        self._ready = asyncio.Event()
        # Whether *our* socket to the broker is currently open, independent of whether
        # the broker can currently reach the projector (state["link"]["connected"]).
        # Both must be true for an entity to be available.
        self.ws_connected = False

    @property
    def url(self) -> str:
        scheme = "ws"
        return f"{scheme}://{self.host}:{self.port}/ws"

    @property
    def available(self) -> bool:
        link = (self.data or {}).get("link") or {}
        return self.ws_connected and bool(link.get("connected"))

    async def async_start(self) -> None:
        self._stopping = False
        self._task = self.hass.loop.create_task(self._run())

    async def async_wait_ready(self, timeout: float) -> bool:
        """Wait for the first state snapshot so entities load with real values on
        first setup instead of starting unavailable. Soft-fails on timeout -- setup
        still proceeds, and the reconnect loop takes over from there."""
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def async_stop(self) -> None:
        self._stopping = True
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _run(self) -> None:
        session = async_get_clientsession(self.hass)
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else None

        while not self._stopping:
            try:
                async with session.ws_connect(
                    self.url, heartbeat=WS_HEARTBEAT_S, headers=headers
                ) as ws:
                    self._ws = ws
                    self.ws_connected = True
                    self._backoff = RECONNECT_INITIAL_S
                    _LOGGER.info("Connected to Epson projector broker at %s", self.url)

                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            self._handle_message(msg.json())
                        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                            break
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as err:
                _LOGGER.debug("Epson projector broker connection error: %s", err)
            finally:
                self._ws = None
                self.ws_connected = False
                self._notify()

            if self._stopping:
                break
            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, RECONNECT_MAX_S)

    def _handle_message(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "state":
            self.data = msg.get("state") or {}
            self._ready.set()
            self._notify()
        elif mtype == "patch":
            merged = dict(self.data)
            merged.update(msg.get("changed") or {})
            self.data = merged
            self._notify()
        elif mtype == "error":
            _LOGGER.warning("Broker rejected command %s: %s", msg.get("cmd"), msg.get("message"))
        # "line" (protocol log), "result" and "pong" are not needed by entities.

    def _notify(self) -> None:
        self.async_set_updated_data(self.data)

    async def async_send_command(self, cmd: str, value=None) -> None:
        if self._ws is None or self._ws.closed:
            raise ConnectionError("Not connected to the Epson projector broker")
        payload: dict = {"type": "command", "cmd": cmd}
        if value is not None:
            payload["value"] = value
        await self._ws.send_json(payload)
