// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

const HEIC_FIXTURE_PATH = NodePath.join(import.meta.dirname, "__fixtures__", "tiny.heic");
const HEIC_FIXTURE_BASE64 = NodeFS.readFileSync(HEIC_FIXTURE_PATH).toString("base64");

function makeTurnStartCommand(attachment: {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}): ClientOrchestrationCommand {
  const dataUrl = `data:${attachment.mimeType};base64,${attachment.base64}`;
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("command-attachment"),
    threadId: ThreadId.make("thread-attachment"),
    message: {
      messageId: MessageId.make("message-attachment"),
      role: "user",
      text: "Here is a screenshot",
      attachments: [
        {
          type: "image",
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: Buffer.from(attachment.base64, "base64").byteLength,
          dataUrl,
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: clientCreatedAt,
  };
}

const TestLayer = WorkspacePaths.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-attachments-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// `it.layer` memoizes and shares TestLayer (and its temp attachments
// directory) across every test in the block, so snapshot the directory
// before running and diff afterward rather than asserting on its full
// contents. That keeps each test's expectations independent of what other
// tests in the block have already written. It also keeps inspection inside
// the same Effect run, since the temp directory is removed as soon as the
// enclosing `it.layer` scope closes.
const runNormalize = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const listFileNames = () =>
      NodeFS.existsSync(serverConfig.attachmentsDir)
        ? NodeFS.readdirSync(serverConfig.attachmentsDir)
        : [];

    const fileNamesBefore = new Set(listFileNames());
    const result = yield* Effect.exit(normalizeDispatchCommand(command));
    const newFileNames = listFileNames().filter((fileName) => !fileNamesBefore.has(fileName));
    const newFiles = new Map(
      newFileNames.map((fileName) => [
        fileName,
        NodeFS.readFileSync(NodePath.join(serverConfig.attachmentsDir, fileName)),
      ]),
    );
    return { result, newFiles };
  });

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

it.layer(TestLayer, { excludeTestServices: true })(
  "normalizeDispatchCommand HEIC ingestion",
  (it) => {
    it.effect("converts a HEIC attachment to JPEG on disk before persisting", () =>
      Effect.gen(function* () {
        const command = makeTurnStartCommand({
          name: "IMG_0001.heic",
          mimeType: "image/heic",
          base64: HEIC_FIXTURE_BASE64,
        });

        const { result, newFiles } = yield* runNormalize(command);

        expect(Exit.isSuccess(result)).toBe(true);
        if (!Exit.isSuccess(result)) {
          throw new Error("Expected normalizeDispatchCommand to succeed");
        }
        const normalizedCommand = result.value;
        if (normalizedCommand.type !== "thread.turn.start") {
          throw new Error("Expected a thread.turn.start command");
        }

        const [persistedAttachment] = normalizedCommand.message.attachments;
        if (!persistedAttachment) {
          throw new Error("Expected a persisted attachment");
        }
        expect(persistedAttachment.mimeType).toBe("image/jpeg");

        expect([...newFiles.keys()]).toEqual([`${persistedAttachment.id}.jpg`]);

        const writtenBytes = newFiles.get(`${persistedAttachment.id}.jpg`)!;
        expect(writtenBytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
        expect(persistedAttachment.sizeBytes).toBe(writtenBytes.byteLength);
      }),
    );

    it.effect("rejects a corrupt HEIC attachment without writing anything to disk", () =>
      Effect.gen(function* () {
        const command = makeTurnStartCommand({
          name: "corrupt.heic",
          mimeType: "image/heic",
          base64: Buffer.from("not a real heic file").toString("base64"),
        });

        const { result, newFiles } = yield* runNormalize(command);

        expect(Exit.isFailure(result)).toBe(true);
        expect([...newFiles.keys()]).toEqual([]);
      }),
    );
  },
);
