"""Power switch: the same control as the media_player, for simple dashboards/automations."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import EpsonBrokerHub
from .entity import EpsonEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    hub: EpsonBrokerHub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([EpsonPowerSwitch(hub)])


class EpsonPowerSwitch(EpsonEntity, SwitchEntity):
    _attr_translation_key = "power"

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-power"

    @property
    def is_on(self) -> bool | None:
        data = self.hub.data or {}
        # Reflect a request in flight so the toggle doesn't snap back for the ~50s the
        # projector takes to warm up; the power_state sensor shows the real phase.
        pending = data.get("pendingPower")
        if pending is not None:
            return pending == "on"
        power = data.get("power")
        if power == "unknown":
            return None
        return power in ("on", "warming")

    async def async_turn_on(self, **kwargs) -> None:
        await self.hub.async_send_command("power", True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.hub.async_send_command("power", False)
