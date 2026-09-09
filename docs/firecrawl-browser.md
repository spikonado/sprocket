# Firecrawl browser sessions

Agents use `browser_interact` for agent-browser commands and `browser_screenshot` for model-visible PNGs. Set `FIRECRAWL_API_KEY` in the Convex deployment. Browserbase actions are retired; older clients must update to use browser tools.

Firecrawl sessions use `browserSessions`. The old Browserbase rows were cleared, and both session tables were confirmed empty in development and production before replacing the schema. There is no separate `firecrawlSessions` table or Browserbase fallback.

Each user has one Firecrawl saved profile. Each conversation has a separate live browser session. Saving is on by default, and Firecrawl permits only one saving session per profile. Another conversation gets `profile_in_use` without executing its action. Passing `disable_saving: true` opens a reader from the last saved profile. It does not save browser state, but purchases, messages, and other website changes still happen.

Saving mode is fixed for the session. The saving toggle under Agent's Browser in settings affects new sessions only. Reset rotates the profile and closes current sessions. It does not erase the old profile at Firecrawl. Native profiles save on close, and the provider may finish saving after its close request returns.

Sessions remain open between agent runs. Firecrawl receives `activityTtl: 450` and `ttl: 3600`, for 7.5 minutes of inactivity and a one-hour hard limit. **Whether live-view human input resets Firecrawl's inactivity timer is unverified.** The public API delegates that behavior to a private browser service. We do not send keepalive heartbeats merely because a viewer is open.

Take control blocks new agent commands until the user gives control back. An in-flight agent command must finish before takeover. This coordinates the Sprocket UI; it does not revoke a provider URL already copied elsewhere.

Convex operation leases serialize commands and fence stale runs. Unknown execution outcomes close the session and require checking the website before retrying a consequential action. Commands are never automatically replayed. A process crash or ambiguous create response can leave an unidentified provider session alive until its provider TTL expires. The provider writer lock prevents a second saving session during that interval.

Reconciliation removes only sessions explicitly reported destroyed, never sessions merely absent from a list. Hard-expiry jobs retry close failures.

Screenshots are limited to 600,000 bytes before base64 encoding; larger images return size metadata without pixels. The agent validates the image and saves it in `transcripts/<user>/<thread>/browser_screenshot/` before completing the tool job. Each image tool uses its own directory. Durable results contain the saved path, media type, byte size, and dimensions, never pixels or page URLs. Like `screenshot_url`, the agent returns both the saved absolute path and the image, including when replaying conversation history. Missing files fall back to a text notice without recapturing the page. Text-only models cannot call the screenshot tool and receive a text notice instead of replayed images.

Screenshot code writes JSON with `process.stdout.write` and waits for its callback before finishing. Live Firecrawl checks returned empty output for `console.log` and intermittently truncated large images for an unawaited stdout write. Waiting for the write returned complete PNGs. The parser also accepts `result` when `stdout` is empty or absent. Empty or malformed output fails explicitly without replaying the capture.

Firecrawl's session list has no documented pagination. Responses over 2 MB fail closed, so a large destroyed-session history can delay local cleanup until hard expiry or the next tool call. It does not extend the provider's session lifetime.
