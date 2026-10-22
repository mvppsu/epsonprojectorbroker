"""Sensors: power phase (off/warming/on/cooling) and laser hours."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, POWER_STATES
from .coordinator import EpsonBrokerHub
from .entity import EpsonEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    hub: EpsonBrokerHub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([EpsonPowerStateSensor(hub), EpsonLaserHoursSensor(hub)])


class EpsonPowerStateSensor(EpsonEntity, SensorEntity):
    _attr_translation_key = "power_state"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = POWER_STATES

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-power_state"

    @property
    def native_value(self) -> str | None:
        return (self.hub.data or {}).get("power")


class EpsonLaserHoursSensor(EpsonEntity, SensorEntity):
    _attr_translation_key = "laser_hours"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.HOURS
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-laser_hours"

    @property
    def native_value(self) -> int | None:
        return (self.hub.data or {}).get("lampHours")
