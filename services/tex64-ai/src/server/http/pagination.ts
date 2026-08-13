import { z } from "zod";

import {
  MAX_PAGE_OFFSET,
  MAX_PAGE_SIZE,
  type ListPageRequest,
} from "@/server/persistence";

const PageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  })
  .strict();

export function parsePageRequest(request: Request): Required<ListPageRequest> {
  const parameters = new URL(request.url).searchParams;
  return PageQuerySchema.parse({
    limit: parameters.get("limit") ?? undefined,
    offset: parameters.get("offset") ?? undefined,
  });
}

export function pageMetadata(
  page: Required<ListPageRequest>,
  itemCount: number,
) {
  const candidateNextOffset = page.offset + itemCount;
  return {
    limit: page.limit,
    offset: page.offset,
    nextOffset:
      itemCount === page.limit && candidateNextOffset <= MAX_PAGE_OFFSET
        ? candidateNextOffset
        : null,
  };
}
