import { Effect, Stream } from 'effect';
import type { ImapFlow } from 'imapflow';
import {
  AttachmentNotFoundError,
  ImapError,
  MessageNotFoundError,
} from '../errors/errors';
import type { AttachmentContent, MessageHandle } from '../schemas/mail';
import { findAttachment } from './attachment-metadata';
import { lockMessageFolder } from './mailbox-lock';

const toBuffer = (chunk: unknown): Effect.Effect<Buffer, ImapError> => {
  if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
    return Effect.succeed(Buffer.from(chunk));
  }
  return Effect.fail(
    new ImapError({ message: 'read attachment returned a non-binary chunk' }),
  );
};

const collectContent = (content: AsyncIterable<unknown>) =>
  Stream.fromAsyncIterable(
    content,
    (cause) =>
      new ImapError({
        message: `read attachment stream failed: ${String(cause)}`,
      }),
  ).pipe(
    Stream.mapEffect(toBuffer),
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(chunks)),
  );

const contentTypeOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

export const readAttachment = (
  client: ImapFlow,
  handle: MessageHandle,
  part: string,
) =>
  Effect.gen(function* () {
    const { folder, uid } = handle;
    yield* lockMessageFolder(client, handle);
    const message = yield* Effect.tryPromise({
      try: () =>
        client.fetchOne(
          String(uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        ),
      catch: (cause) =>
        new ImapError({
          message: `fetch attachment metadata failed: ${String(cause)}`,
        }),
    });
    if (message === false || message === undefined) {
      return yield* Effect.fail(
        new MessageNotFoundError({
          folder,
          uid,
          message: `Message uid ${uid} not found in "${folder}"`,
        }),
      );
    }
    const attachment = findAttachment(message.bodyStructure, part);
    if (attachment === undefined) {
      return yield* Effect.fail(
        new AttachmentNotFoundError({
          folder,
          uid,
          part,
          message: `Attachment part ${part} not found in message uid ${uid} in "${folder}"; read the message again for current part handles`,
        }),
      );
    }
    const download = yield* Effect.tryPromise({
      try: () => client.download(String(uid), part, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `download attachment part ${part} failed: ${String(cause)}`,
        }),
    });
    if (download.meta === undefined || download.content === undefined) {
      return yield* Effect.fail(
        new AttachmentNotFoundError({
          folder,
          uid,
          part,
          message: `Attachment part ${part} could not be downloaded from message uid ${uid} in "${folder}"; read the message again for current part handles`,
        }),
      );
    }
    const content = yield* collectContent(
      download.content as AsyncIterable<unknown>,
    );
    return {
      ...attachment,
      filename: download.meta.filename ?? attachment.filename,
      contentType: contentTypeOr(
        download.meta.contentType,
        attachment.contentType,
      ),
      size: content.byteLength,
      content,
    } satisfies AttachmentContent;
  }).pipe(Effect.scoped);
