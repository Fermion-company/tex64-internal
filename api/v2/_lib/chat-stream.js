/** Parse provider SSE events across byte, line and UTF-8 boundaries. */
export function createChatEventReader(onEvent, onHeartbeat) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];

  const dispatch = () => {
    if (data.length) onEvent(data.join("\n"));
    data = [];
  };

  const readLine = (line) => {
    if (line === "") {
      dispatch();
    } else if (line.startsWith(":")) {
      onHeartbeat();
    } else if (line === "data" || line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  };

  const read = (end) => {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char !== "\n" && char !== "\r") continue;
      if (!end && char === "\r" && i + 1 === buffer.length) break;
      readLine(buffer.slice(start, i));
      if (char === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (end) {
      if (buffer) readLine(buffer);
      dispatch();
    }
  };

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      read(false);
    },
    finish() {
      buffer += decoder.decode();
      read(true);
    },
  };
}
