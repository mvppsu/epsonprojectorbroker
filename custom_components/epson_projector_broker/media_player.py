"""The main media_player entity: power and source."""

from __future__ import annotations

from homeassistant.components.media_player import (
    MediaPlayerDeviceClass,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import EpsonBrokerHub
from .entity import EpsonEntity

FEATURES = (
    MediaPlayerEntityFeature.TURN_ON
    | MediaPlayerEntityFeature.TURN_OFF
    | MediaPlayerEntityFeature.SELECT_SOURCE
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    hub: EpsonBrokerHub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([EpsonMediaPlayer(hub)])


class EpsonMediaPlayer(EpsonEntity, MediaPlayerEntity):
    _attr_name = None  # has_entity_name: use the device's own name
    _attr_supported_features = FEATURES
    _attr_device_class = MediaPlayerDeviceClass.TV

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-media_player"

    @property
    def state(self) -> MediaPlayerState | None:
        power = (self.hub.data or {}).get("power")
        # "warming" counts as ON: the projector has accepted power-on and the image is
        # on its way (~50s). "cooling" counts as OFF for the same reason in reverse.
        if power in ("on", "warming"):
            return MediaPlayerState.ON
        if power in ("off", "cooling"):
            return MediaPlayerState.OFF
        return None

    @property
    def source(self) -> str | None:
        return (self.hub.data or {}).get("inputName")

    @property
    def source_list(self) -> list[str]:
        return [i["name"] for i in (self.hub.data or {}).get("sourceList") or []]

    @property
    def extra_state_attributes(self) -> dict:
        data = self.hub.data or {}
        return {"power_state": data.get("power"), "pending_power": data.get("pendingPower")}

    async def async_turn_on(self) -> None:
        await self.hub.async_send_command("power", True)

    async def async_turn_off(self) -> None:
        await self.hub.async_send_command("power", False)

    async def async_select_source(self, source: str) -> None:
        await self.hub.async_send_command("input", source)
