import { Crosshair, FlaskConical, LifeBuoy, Package, Radar, Rocket, Wrench } from "lucide-react";
import { CapyApiKeyIcon, CapyCloudIcon, CapyShieldIcon, CapySparkleIcon, type IconComponent } from "@/ui/icons/capy";

/**
 * Icon ids a Sentinel avatar can carry (engine `avatar.icon`). Capy glyphs where Capy has one; lucide
 * only for target, package, wrench, radar, lifebuoy, flask and rocket, which Capy's set does not include.
 */
export const SENTINEL_ICONS: Readonly<Record<string, IconComponent>> = {
  target: Crosshair, shield: CapyShieldIcon, package: Package, wrench: Wrench, key: CapyApiKeyIcon, radar: Radar,
  cloud: CapyCloudIcon, lifebuoy: LifeBuoy, flask: FlaskConical, rocket: Rocket, sparkle: CapySparkleIcon,
};
