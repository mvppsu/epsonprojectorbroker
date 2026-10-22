"""Config flow for the Epson Projector Broker integration."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Optional(CONF_TOKEN, default=""): str,
    }
)


async def _async_try_connect(hass: HomeAssistant, host: str, port: int, token: str) -> None:
    """Raise CannotConnect if the broker's /ws endpoint doesn't respond."""
    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {token}"} if token else None
    try:
        async with session.ws_connect(
            f"ws://{host}:{port}/ws", headers=headers, timeout=5
        ) as ws:
            async with asyncio.timeout(5):
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        return
                    break
            raise CannotConnect
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as err:
        raise CannotConnect from err


class CannotConnect(Exception):
    """Could not reach the Epson projector broker's WebSocket endpoint."""


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST]
            port = user_input[CONF_PORT]
            token = user_input.get(CONF_TOKEN, "")

            await self.async_set_unique_id(f"{host}:{port}")
            self._abort_if_unique_id_configured()

            try:
                await _async_try_connect(self.hass, host, port, token)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(
                    title=f"Epson projector ({host})",
                    data={CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token},
                )

        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors)
