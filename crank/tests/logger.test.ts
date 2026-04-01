import { expect } from "chai";
import { createLogger, LogEntry } from "../src/logger";

describe("logger", () => {
  it("outputs valid JSON with required fields", () => {
    const lines: string[] = [];
    const log = createLogger("test-module", (line) => lines.push(line));

    log.info("hello world");

    expect(lines).to.have.length(1);
    const entry: LogEntry = JSON.parse(lines[0]);
    expect(entry.level).to.equal("info");
    expect(entry.module).to.equal("test-module");
    expect(entry.msg).to.equal("hello world");
    expect(entry.ts).to.be.a("string");
    // Verify ISO format
    expect(new Date(entry.ts).toISOString()).to.equal(entry.ts);
  });

  it("includes extra fields in output", () => {
    const lines: string[] = [];
    const log = createLogger("monitor", (line) => lines.push(line));

    log.info("Found exits", { count: 3, exitPda: "abc123" });

    const entry: LogEntry = JSON.parse(lines[0]);
    expect(entry.count).to.equal(3);
    expect(entry.exitPda).to.equal("abc123");
    expect(entry.module).to.equal("monitor");
  });

  it("emits correct level for warn and error", () => {
    const lines: { line: string; level: string }[] = [];
    const log = createLogger("test", (line, level) =>
      lines.push({ line, level })
    );

    log.warn("something off");
    log.error("something broke", { error: "bad stuff" });

    expect(lines).to.have.length(2);

    const warn: LogEntry = JSON.parse(lines[0].line);
    expect(warn.level).to.equal("warn");
    expect(warn.msg).to.equal("something off");

    const err: LogEntry = JSON.parse(lines[1].line);
    expect(err.level).to.equal("error");
    expect(err.msg).to.equal("something broke");
    expect(err.error).to.equal("bad stuff");
    expect(lines[1].level).to.equal("error");
  });

  it("tags each entry with the module name", () => {
    const lines: string[] = [];
    const log1 = createLogger("monitor", (line) => lines.push(line));
    const log2 = createLogger("emergency", (line) => lines.push(line));

    log1.info("from monitor");
    log2.info("from emergency");

    const e1: LogEntry = JSON.parse(lines[0]);
    const e2: LogEntry = JSON.parse(lines[1]);
    expect(e1.module).to.equal("monitor");
    expect(e2.module).to.equal("emergency");
  });
});
