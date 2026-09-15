import { renderCompactDoctor, renderDoctor } from "../src/doctor-ui";
import type { DoctorScenario } from "../test/fixtures/doctor-scenarios";
import { galleryWidths, writeTerminalGallery } from "./terminal-gallery";

export const writeDoctorGallery = (directory: string, scenarios: DoctorScenario[]): string =>
  writeTerminalGallery(
    directory,
    scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      reports: Object.fromEntries(
        galleryWidths.map((width) => [
          width,
          {
            full: renderDoctor(scenario.result, { width, color: true }),
            compact: renderCompactDoctor(scenario.result, { width, color: true }),
          },
        ])
      ),
    })),
    "doctor"
  );
