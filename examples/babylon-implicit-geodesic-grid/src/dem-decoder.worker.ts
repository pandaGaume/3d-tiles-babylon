/// <reference lib="webworker" />
import { installDemDecoderWorker, type IDemWorkerScope } from "@spacexr/tiles";

// Decodes Mapzen PNG tiles and their elevations off the rendering thread.
installDemDecoderWorker(self as unknown as IDemWorkerScope);
