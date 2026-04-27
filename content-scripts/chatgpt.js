let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observationInterval = null;
let observer = null;
let responseInFlight = false;
let lastSentResponseText = "";
let assistantTextAtQuestion = "";
let pendingCandidateText = "";
let pendingCandidateSeenAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    messageCountAtQuestion = messages.length;
    assistantTextAtQuestion = getLatestAssistantResponseText();
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  responseInFlight = false;
  observationStartTime = 0;
  pendingCandidateText = "";
  pendingCandidateSeenAt = 0;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observationInterval) {
    clearInterval(observationInterval);
    observationInterval = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
  const text = buildPrompt(questionData);
  const inputArea = await waitForChatInput();

  inputArea.focus();

  if ("value" in inputArea) {
    inputArea.value = text;
    inputArea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  } else {
    inputArea.textContent = "";
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      inputArea.textContent = text;
    }
    inputArea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  }

  inputArea.dispatchEvent(new Event("change", { bubbles: true }));

  const sendButton = await waitForSendButton();
  sendButton.click();
  startObserving();
}

function buildPrompt(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "connect_slot_graph") {
    return buildSlotGraphPrompt(questionData);
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
}

function buildSlotGraphPrompt(questionData) {
  const { prompt, context, slots, previousCorrection } = questionData;
  const slotList = Array.isArray(slots) ? slots : [];

  let text = "";

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text +=
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${previousCorrection.question}", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question.\n\n`;
  }

  text += `Question / page prompt:\n${prompt || ""}`;

  if (context && context !== prompt) {
    text += `\n\nFull page context:\n${context}`;
  }

  text += `\n\nFillable slots (you must return a value for each slot you can answer):\n${JSON.stringify(
    slotList,
    null,
    2
  )}`;

  text += `\n\nReturn JSON of the form: {"slots": {"<slot id>": <value>, ...}, "explanation": "<one sentence>"}`;
  text += `\n\nReturn only the raw JSON object — no markdown fences, no acknowledgements, no prose outside the JSON.`;
  text += `\n\nRules:`;
  text += `\n- Use the exact slot ids from the slots list as the keys.`;
  text += `\n- For dropdown slots, the value must be EXACTLY one of the option strings shown in that slot's "options".`;
  text += `\n- For choice / boolean slots (single selection), the value is the exact option string you want to pick.`;
  text += `\n- For multi_choice slots, the value is an array of exact option strings.`;
  text += `\n- For number slots, write the number as you would type it. For NEGATIVE numbers in McGraw's accounting cells, use parentheses, e.g. "(4,976)" — McGraw stores negatives that way.`;
  text += `\n- For text slots, write the natural-language answer as a string.`;
  text += `\n- If a slot has no answer (truly blank cell), omit it or set its value to null. Do not invent values.`;
  text += `\n- Use slot "hint", "group", and "groupRole" to keep paired cells (label/amount, debit/credit, row 1/row 2) consistent.`;
  text += `\n- Do NOT emit any other keys (no "actions", no selectors). The page knows how to apply each slot.`;
  text += `\n\nDO NOT acknowledge any correction in your response, only answer the new question.`;

  return text;
}

function waitForChatInput(timeout = 15000) {
  return waitForElement(
    [
      "#prompt-textarea",
      '[contenteditable="true"][data-lexical-editor="true"]',
      'textarea[data-testid="prompt-textarea"]',
      "textarea",
    ],
    timeout,
    (element) => !element.disabled && !element.getAttribute("aria-disabled")
  );
}

function waitForSendButton(timeout = 10000) {
  return waitForElement(
    [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[data-testid="fruitjuice-send-button"]',
    ],
    timeout,
    (element) =>
      !element.disabled && element.getAttribute("aria-disabled") !== "true"
  );
}

function waitForElement(selectors, timeout, predicate = () => true) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && predicate(element)) {
          clearInterval(interval);
          resolve(element);
          return;
        }
      }

      if (Date.now() - startedAt > timeout) {
        clearInterval(interval);
        reject(new Error(`Element not found: ${selectors.join(", ")}`));
      }
    }, 150);
  });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      notifyAiResponseTimeout();
      resetObservation();
    }
  }, 180000);

  observationInterval = setInterval(() => {
    tryCaptureLatestResponse();
  }, 1000);

  observer = new MutationObserver(() => {
    tryCaptureLatestResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function tryCaptureLatestResponse() {
  if (responseInFlight || !observationStartTime) return;

  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  if (messages.length <= messageCountAtQuestion) return;

  const latestMessage = messages[messages.length - 1];
  if (isResponseStillGenerating(latestMessage)) return;

  const responseText = repairJsonResponseText(extractJsonText(latestMessage));
  if (
    !responseText ||
    responseText === lastSentResponseText ||
    responseText === assistantTextAtQuestion
  ) {
    return;
  }

  if (responseText !== pendingCandidateText) {
    pendingCandidateText = responseText;
    pendingCandidateSeenAt = Date.now();
    return;
  }

  if (Date.now() - pendingCandidateSeenAt < 600) {
    return;
  }

  try {
    const parsed = JSON.parse(responseText);
    if (parsed.answer !== undefined || parsed.actions || parsed.slots) {
      responseInFlight = true;
      hasResponded = true;
      chrome.runtime
        .sendMessage({
          type: "chatGPTResponse",
          response: responseText,
        })
        .then(() => {
          lastSentResponseText = responseText;
          resetObservation();
        })
        .catch((error) => {
          responseInFlight = false;
          hasResponded = false;
          console.error("Error sending response:", error);
        });
    }
  } catch (error) {
    if (Date.now() - observationStartTime > 30000) {
      const fallback = repairJsonResponseText(
        findJsonObject(latestMessage.textContent.trim())
      );
      if (
        fallback &&
        fallback !== lastSentResponseText &&
        fallback !== assistantTextAtQuestion
      ) {
        responseInFlight = true;
        hasResponded = true;
        chrome.runtime
          .sendMessage({
            type: "chatGPTResponse",
            response: fallback,
          })
          .then(() => {
            lastSentResponseText = fallback;
            resetObservation();
          })
          .catch((sendError) => {
            responseInFlight = false;
            hasResponded = false;
            console.error("Error sending fallback response:", sendError);
          });
      }
    }
  }
}

function notifyAiResponseTimeout() {
  try {
    chrome.runtime.sendMessage({
      type: "aiResponseTimeout",
      aiModel: "chatgpt",
      reason: "ChatGPT did not produce a response within 180 seconds.",
    });
  } catch (error) {
    console.error("Error notifying timeout:", error);
  }
}

function isResponseStillGenerating(message) {
  return Boolean(
    document.querySelector('[data-testid="stop-button"]') ||
      message.querySelector(".result-streaming") ||
      message
        .closest('[data-message-author-role="assistant"]')
        ?.querySelector('[aria-label*="Stop"], [data-testid*="stop"]')
  );
}

function getLatestAssistantResponseText() {
  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  if (!messages.length) return "";

  const latestMessage = messages[messages.length - 1];
  return repairJsonResponseText(extractJsonText(latestMessage));
}

function extractJsonText(message) {
  const codeBlocks = message.querySelectorAll("pre code");

  for (const block of codeBlocks) {
    const text = sanitizeResponseText(block.textContent);
    if (looksLikeJsonResponse(text)) return text;
  }

  const text = sanitizeResponseText(message.textContent);
  return findJsonObject(text);
}

function sanitizeResponseText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function looksLikeJsonResponse(text) {
  return (
    text.startsWith("{") &&
    text.endsWith("}") &&
    /"answer"|"actions"|"slots"/.test(text)
  );
}

function findJsonObject(text) {
  const value = sanitizeResponseText(text);
  if (looksLikeJsonResponse(value)) return value;

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return "";
  }

  return value.slice(firstBrace, lastBrace + 1);
}

function repairJsonResponseText(text) {
  return String(text || "")
    .replace(
      /\[data-automcgraw-id="([^"]+)"\]/g,
      "[data-automcgraw-id='$1']"
    )
    .replace(/\[id="([^"]+)"\]/g, "[id='$1']");
}
