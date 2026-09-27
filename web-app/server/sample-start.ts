import { prepareSample, sampleDirectory, samplePassword } from "./sample";

await prepareSample();
process.env.FOCUS_LOCAL = "1";
process.env.SECURE_COOKIES = "0";
process.env.DATA_DIR = sampleDirectory;
process.env.HOST = "127.0.0.1";
process.env.PORT ||= "4310";
console.log(`Sample workspace: http://127.0.0.1:${process.env.PORT}`);
console.log(`Sample password: ${samplePassword}`);
await import("./index");
