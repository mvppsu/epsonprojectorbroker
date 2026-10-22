"""The Epson Projector Broker integration: bridges Home Assistant to epson-projector-broker."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant

from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN, PLATFORMS
from .coordinator import EpsonBrokerHub


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hub = EpsonBrokerHub(
        hass,
        entry.data[CONF_HOST],
        entry.data.get(CONF_PORT, DEFAULT_PORT),
        entry.data.get(CONF_TOKEN) or None,
    )
    await hub.async_start()
    # Best-effort: let entities load with real values on first setup rather than
    # starting unavailable. If the broker is briefly unreachable, setup still
    # succeeds -- the hub's own reconnect loop keeps trying in the background.
    await hub.async_wait_ready(timeout=10)

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = hub

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hub: EpsonBrokerHub = hass.data[DOMAIN].pop(entry.entry_id)
        await hub.async_stop()
    return unload_ok


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
