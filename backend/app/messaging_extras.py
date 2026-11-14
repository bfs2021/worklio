"""Services for Wave A2 messaging extras.

- `enrich`: adds pins, forwards, polls, link previews and edit counts to serialized messages
  (a handful of batched queries per page, called from services.serialize_messages).
- Special mentions: `<!here>`, `<!channel>`, `<!everyone>` and `<!subteam^GROUP_ID>`.
- Link unfurls: URL extraction, an SSRF-safe fetcher, OpenGraph parsing and a 24 h cache.
- Scheduled messages: exactly-once delivery through the normal post path.
- Search: `from: in: has: before: after: on: is:` filters.
"""

import asyncio
import hashlib
import ipaddress
import logging
import re
import socket
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx
from fastapi import HTTPException, status
from sqlalchemy import and_, exists, false, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models import (
    Attachment,
    Channel,
    ChannelKind,
    ChannelMember,
    LinkPreview,
    Message,
    MessageForward,
    MessagePin,
    MessageReaction,
    MessageRevision,
    MessageUnfurl,
    Poll,
    PollOption,
    PollVote,
    ScheduledMessage,
    User,
    UserGroup,
    UserGroupMember,
    WorkspaceMember,
    WorkspaceRole,
)
from app.realtime.hub import notify_user, online_user_ids, publish_to_channel, publish_to_workspace
from app.schemas import ForwardedFromOut, MessageOut, PollOptionOut, PollOut, UnfurlOut

log = logging.getLogger(__name__)

__all__ = [
    "notify_user",
    "publish_to_channel",
    "publish_to_workspace",
]

# Fire-and-forget tasks kept alive until they finish.
_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


def message_event(kind: str, msg: MessageOut) -> dict:
    return {"type": kind, "message": msg.model_dump(mode="json")}


async def get_readable_message(db: AsyncSession, user: User, message_id: uuid.UUID):
    """The message and its channel, if the user can read it (404 otherwise, tenant-safe)."""
    from app.api.deps import require_channel_access

    msg = await db.get(Message, message_id)
    if not msg or msg.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    channel = await require_channel_access(msg.channel_id, db, user)
    return msg, channel


# --- Enrichment -----------------------------------------------------------------------------


async def load_polls(
    db: AsyncSession, polls: list[Poll], viewer_id: uuid.UUID | None = None
) -> dict[uuid.UUID, PollOut]:
    """PollOut per poll id. `my_votes` is filled only for `viewer_id`."""
    if not polls:
        return {}
    ids = [p.id for p in polls]
    options: dict[uuid.UUID, list[PollOption]] = defaultdict(list)
    for o in await db.scalars(
        select(PollOption).where(PollOption.poll_id.in_(ids)).order_by(PollOption.position)
    ):
        options[o.poll_id].append(o)
    voters: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)  # option id -> user ids
    poll_voters: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    mine: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for poll_id, option_id, user_id in await db.execute(
        select(PollVote.poll_id, PollVote.option_id, PollVote.user_id)
        .where(PollVote.poll_id.in_(ids))
        .order_by(PollVote.created_at)
    ):
        voters[option_id].append(user_id)
        poll_voters[poll_id].add(user_id)
        if user_id == viewer_id:
            mine[poll_id].append(option_id)
    out = {}
    for p in polls:
        out[p.id] = PollOut(
            id=p.id,
            question=p.question,
            multiple=p.multiple,
            anonymous=p.anonymous,
            closed=p.closed_at is not None,
            total_voters=len(poll_voters[p.id]),
            my_votes=mine[p.id],
            options=[
                PollOptionOut(
                    id=o.id,
                    text=o.text,
                    votes=len(voters[o.id]),
                    voter_ids=[] if p.anonymous else voters[o.id],
                )
                for o in options[p.id]
            ],
        )
    return out


async def enrich(
    db: AsyncSession, items: list[MessageOut], viewer_id: uuid.UUID | None = None
) -> None:
    """Fill pinned / forwarded_from / poll / unfurls / edit_count on serialized messages."""
    if not items:
        return
    ids = [i.id for i in items]
    pins = dict(
        (await db.execute(
            select(MessagePin.message_id, MessagePin.pinned_by).where(MessagePin.message_id.in_(ids))
        )).all()
    )
    forwards = {
        f.message_id: f
        for f in await db.scalars(select(MessageForward).where(MessageForward.message_id.in_(ids)))
    }
    edit_counts = dict(
        (await db.execute(
            select(MessageRevision.message_id, func.count())
            .where(MessageRevision.message_id.in_(ids))
            .group_by(MessageRevision.message_id)
        )).all()
    )
    unfurls = dict(
        (await db.execute(
            select(MessageUnfurl.message_id, MessageUnfurl.items).where(
                MessageUnfurl.message_id.in_(ids)
            )
        )).all()
    )
    polls = list(await db.scalars(select(Poll).where(Poll.message_id.in_(ids))))
    poll_out = await load_polls(db, polls, viewer_id)
    poll_by_message = {p.message_id: poll_out[p.id] for p in polls}

    for item in items:
        if item.id in pins:
            item.pinned, item.pinned_by = True, pins[item.id]
        if f := forwards.get(item.id):
            item.forwarded_from = ForwardedFromOut(
                message_id=f.source_message_id,
                channel_id=f.source_channel_id,
                author_id=f.source_author_id,
                created_at=f.source_created_at,
                body_preview=f.body_preview,
            )
        item.edit_count = edit_counts.get(item.id, 0)
        item.unfurls = [UnfurlOut(**u) for u in unfurls.get(item.id) or []]
        item.poll = poll_by_message.get(item.id)


# --- Special mentions -------------------------------------------------------------------------

_BROADCAST_RE = re.compile(r"<!(here|channel|everyone)>")
_GROUP_RE = re.compile(r"<!subteam\^([0-9a-fA-F-]{36})>")


def special_mentions(body: str) -> tuple[set[str], set[uuid.UUID]]:
    """(broadcast kinds, group ids) mentioned in a body."""
    groups = set()
    for raw in _GROUP_RE.findall(body):
        try:
            groups.add(uuid.UUID(raw))
        except ValueError:
            continue
    return set(_BROADCAST_RE.findall(body)), groups


async def expand_special_mentions(db: AsyncSession, message: Message) -> set[uuid.UUID]:
    """Users notified by @here / @channel / @everyone / @group in a message.

    Broadcasts only count when the author is a member of the channel; @here reaches the
    members online right now. Groups expand to their members who can read the channel.
    """
    kinds, group_ids = special_mentions(message.body)
    if not kinds and not group_ids:
        return set()
    members = set(
        await db.scalars(
            select(ChannelMember.user_id).where(ChannelMember.channel_id == message.channel_id)
        )
    )
    out: set[uuid.UUID] = set()
    if kinds and message.author_id in members:
        if kinds & {"channel", "everyone"}:
            out |= members
        else:
            try:
                out |= set(await online_user_ids(sorted(members)))
            except Exception:  # presence is best-effort; never block a post on Redis
                log.warning("Could not read presence for @here", exc_info=True)
    if group_ids:
        in_groups = set(
            await db.scalars(
                select(UserGroupMember.user_id)
                .join(UserGroup, UserGroup.id == UserGroupMember.group_id)
                .where(
                    UserGroup.id.in_(group_ids),
                    UserGroup.workspace_id == message.workspace_id,
                )
            )
        )
        channel = await db.get(Channel, message.channel_id)
        readable = in_groups & members
        if channel and channel.kind == ChannelKind.public and in_groups - members:
            # Non-guest workspace members can read public channels without joining.
            readable |= set(
                await db.scalars(
                    select(WorkspaceMember.user_id).where(
                        WorkspaceMember.workspace_id == message.workspace_id,
                        WorkspaceMember.user_id.in_(in_groups - members),
                        WorkspaceMember.role != WorkspaceRole.guest,
                    )
                )
            )
        out |= readable
    return out


# --- Link unfurls -----------------------------------------------------------------------------

UNFURL_MAX_LINKS = 3
UNFURL_TIMEOUT_SECONDS = 5.0
UNFURL_MAX_BYTES = 1024 * 1024
UNFURL_MAX_REDIRECTS = 3
UNFURL_CACHE_TTL = timedelta(hours=24)
UNFURL_FAILURE_TTL = timedelta(hours=1)
USER_AGENT = "WorklioBot/1.0 (+https://worklio.app/bot)"

# Same shape as the client's link tokenizer (src/lib/format.tsx).
_URL_RE = re.compile(r"https?://[^\s<>]+[^\s<>.,;:!?)\]'\"]", re.IGNORECASE)
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class UnsafeURLError(Exception):
    """The URL points at a non-public address (or isn't a fetchable http(s) URL)."""


def extract_urls(body: str, limit: int = UNFURL_MAX_LINKS) -> list[str]:
    out: list[str] = []
    for url in _URL_RE.findall(body or ""):
        if len(url) <= 2048 and url not in out:
            out.append(url)
        if len(out) >= limit:
            break
    return out


def is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for globally routable unicast addresses (no private/loopback/link-local...)."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_public_ip(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            return is_public_ip(ip.sixtofour)
        if ip.teredo is not None:
            return False
        if ip in _NAT64:
            return is_public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return bool(
        ip.is_global
        and not ip.is_multicast
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_reserved
        and not ip.is_unspecified
    )


async def _resolve(host: str, port: int) -> list[str]:
    """DNS lookup (monkeypatched in tests so they never touch the network)."""
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )
    return list(dict.fromkeys(info[4][0] for info in infos))


async def safe_addresses(host: str, port: int) -> list[str]:
    """Resolve `host` and return its addresses, refusing if *any* of them is non-public."""
    host = (host or "").strip("[]").rstrip(".").lower()
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise UnsafeURLError(f"Blocked host {host!r}")
    try:
        literal = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None:
        addrs = [str(literal)]
    else:
        try:
            addrs = await _resolve(host, port)
        except (OSError, UnicodeError) as e:
            raise UnsafeURLError(f"Could not resolve {host!r}") from e
    if not addrs:
        raise UnsafeURLError(f"No addresses for {host!r}")
    for a in addrs:
        try:
            ip = ipaddress.ip_address(a.split("%", 1)[0])
        except ValueError as e:
            raise UnsafeURLError(f"Bad address {a!r}") from e
        if not is_public_ip(ip):
            raise UnsafeURLError(f"{host!r} resolves to a non-public address")
    return addrs


async def check_url(url: str) -> None:
    """Scheme/host/credentials check plus DNS + IP check of the URL's host."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise UnsafeURLError("Malformed URL") from e
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeURLError("Only http(s) URLs can be previewed")
    if parts.username or parts.password:
        raise UnsafeURLError("URLs with credentials are not fetched")
    await safe_addresses(parts.hostname, port or (443 if scheme == "https" else 80))


class SafeNetworkBackend(httpcore.AsyncNetworkBackend):
    """Resolves, validates and connects to the *validated IP* on every connection.

    This is what makes the fetcher safe against DNS rebinding: the address checked is the
    address dialed. TLS still verifies the certificate for the original host name (httpcore
    passes it as SNI/server_hostname separately).
    """

    def __init__(self) -> None:
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        host = host.decode() if isinstance(host, bytes) else host
        addrs = await safe_addresses(host, port)
        last: Exception | None = None
        for addr in addrs[:4]:
            try:
                return await self._inner.connect_tcp(
                    addr, port, timeout=timeout, local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout, OSError) as e:
                last = e
        raise httpcore.ConnectError(str(last) if last else "Could not connect")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise UnsafeURLError("Unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def safe_transport() -> httpx.AsyncHTTPTransport:
    transport = httpx.AsyncHTTPTransport(trust_env=False, retries=0)
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(),
        max_connections=10,
        network_backend=SafeNetworkBackend(),
    )
    return transport


class _MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.icons: list[tuple[str, str]] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").strip().lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower().split()
            if "icon" in rel or "apple-touch-icon" in rel:
                self.icons.append((" ".join(rel), a["href"]))
        elif tag == "title" and not self.title:
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _clean(value: str | None, limit: int) -> str | None:
    value = re.sub(r"\s+", " ", value or "").strip()
    if not value:
        return None
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _abs_http(base: str, href: str | None) -> str | None:
    if not href:
        return None
    url = urljoin(base, href.strip())
    return url if urlsplit(url).scheme in ("http", "https") and len(url) <= 2048 else None


def parse_html_preview(html: str, url: str, final_url: str | None = None) -> dict | None:
    """OpenGraph / Twitter card / <title> metadata as an Unfurl dict (None if nothing useful)."""
    parser = _MetaParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # malformed markup: use whatever was parsed
        log.debug("HTML parse error for %s", url, exc_info=True)
    m = parser.meta
    base = final_url or url
    title = _clean(m.get("og:title") or m.get("twitter:title") or parser.title, 200)
    description = _clean(
        m.get("og:description") or m.get("twitter:description") or m.get("description"), 500
    )
    image = _abs_http(
        base,
        m.get("og:image:secure_url") or m.get("og:image") or m.get("og:image:url")
        or m.get("twitter:image") or m.get("twitter:image:src"),
    )
    if not (title or description or image):
        return None
    host = (urlsplit(base).hostname or "").removeprefix("www.")
    icon = next((h for rel, h in parser.icons if "apple-touch-icon" not in rel), None)
    icon = icon or next((h for _, h in parser.icons), None) or "/favicon.ico"
    return UnfurlOut(
        url=url,
        title=title,
        description=description,
        image_url=image,
        site_name=_clean(m.get("og:site_name") or m.get("application-name") or host, 100),
        favicon_url=_abs_http(base, icon),
    ).model_dump()


async def _read_capped(resp: httpx.Response, limit: int) -> bytes:
    buf = bytearray()
    async for chunk in resp.aiter_bytes():
        buf += chunk
        if len(buf) >= limit:
            del buf[limit:]
            break
    return bytes(buf)


async def fetch_preview(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> dict | None:
    """Fetch `url` safely and return its preview. Raises UnsafeURLError for blocked targets.

    Redirects are followed by hand (max 3) so every hop is re-validated.
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "en",
    }
    async with asyncio.timeout(UNFURL_TIMEOUT_SECONDS):
        async with httpx.AsyncClient(
            transport=transport or safe_transport(),
            follow_redirects=False,
            timeout=UNFURL_TIMEOUT_SECONDS,
            headers=headers,
            trust_env=False,
        ) as client:
            current = url
            for _ in range(UNFURL_MAX_REDIRECTS + 1):
                await check_url(current)
                async with client.stream("GET", current) as resp:
                    if resp.is_redirect:
                        location = resp.headers.get("location")
                        if not location:
                            return None
                        current = urljoin(str(resp.url), location)
                        continue
                    if resp.status_code != 200:
                        return None
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    if ctype and ctype not in ("text/html", "application/xhtml+xml"):
                        return None
                    declared = resp.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > UNFURL_MAX_BYTES * 10:
                        return None
                    raw = await _read_capped(resp, UNFURL_MAX_BYTES)
                    html = raw.decode(resp.charset_encoding or "utf-8", errors="replace")
                    return parse_html_preview(html, url, str(resp.url))
            return None  # too many redirects


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


async def get_preview(db: AsyncSession, url: str, *, fetch=None) -> dict | None:
    """Cached preview for a URL (24 h; failures are retried after an hour)."""
    key = _url_hash(url)
    cached = await db.get(LinkPreview, key)
    now = datetime.now(UTC)
    if cached is not None:
        ttl = UNFURL_CACHE_TTL if cached.data else UNFURL_FAILURE_TTL
        if cached.fetched_at > now - ttl:
            return {**cached.data, "url": url} if cached.data else None
    try:
        data = await (fetch or fetch_preview)(url)
    except UnsafeURLError as e:
        log.info("Not unfurling %s: %s", url, e)
        data = None
    except Exception:  # network errors, timeouts, bad TLS...
        log.info("Unfurl of %s failed", url, exc_info=True)
        data = None
    await db.execute(
        pg_insert(LinkPreview)
        .values(url_hash=key, url=url, data=data, fetched_at=now)
        .on_conflict_do_update(index_elements=["url_hash"], set_={"data": data, "fetched_at": now})
    )
    await db.commit()
    return data


async def sync_unfurl_urls(db: AsyncSession, message: Message) -> bool:
    """Record the links in the message body (call before commit). True if a fetch is needed."""
    if message.kind == "system":
        return False
    urls = extract_urls(message.body)
    row = await db.get(MessageUnfurl, message.id)
    if row is None:
        if not urls:
            return False
        row = MessageUnfurl(message_id=message.id, urls=urls, items=[], hidden_urls=[])
        db.add(row)
        return True
    row.urls = urls
    row.items = [i for i in row.items or [] if i.get("url") in urls]
    have = {i.get("url") for i in row.items}
    return any(u not in have and u not in (row.hidden_urls or []) for u in urls)


def _send_unfurl_task(message_id: uuid.UUID) -> None:
    from app.workers.celery_app import celery_app

    celery_app.send_task("app.workers.tasks.unfurl_message", args=[str(message_id)])


def schedule_unfurl(message_id: uuid.UUID) -> None:
    """Fire-and-forget: enqueue the Celery unfurl task without blocking the request."""

    async def _go() -> None:
        try:
            await asyncio.to_thread(_send_unfurl_task, message_id)
        except Exception:
            log.warning("Could not schedule unfurl for message %s", message_id, exc_info=True)

    _spawn(_go())


async def run_unfurls(db: AsyncSession, message_id: uuid.UUID, *, fetch=None) -> bool:
    """Fetch previews for a message's links, store them and broadcast. True if they changed."""
    from app.services import serialize_message

    row = await db.get(MessageUnfurl, message_id)
    msg = await db.get(Message, message_id)
    if row is None or msg is None or msg.deleted_at is not None:
        return False
    wanted = [u for u in row.urls or [] if u not in (row.hidden_urls or [])]
    previews = {}
    for url in wanted:
        data = await get_preview(db, url, fetch=fetch)
        if data:
            previews[url] = {**data, "url": url}
    # The body may have been edited (or a preview hidden) while we were fetching.
    row = await db.scalar(
        select(MessageUnfurl)
        .where(MessageUnfurl.message_id == message_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        await db.commit()
        return False
    hidden = set(row.hidden_urls or [])
    items = [previews[u] for u in row.urls or [] if u in previews and u not in hidden]
    if items == (row.items or []):
        await db.commit()
        return False
    row.items = items
    await db.commit()
    msg = await db.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        return True
    out = await serialize_message(db, msg)
    await publish_to_channel(msg.channel_id, message_event("message.updated", out))
    return True


# --- Edit history / read state ----------------------------------------------------------------


def record_edit(db: AsyncSession, message: Message, old_body: str) -> None:
    """Keep the previous body when an edit changes it (call before commit)."""
    if old_body != message.body:
        db.add(MessageRevision(message_id=message.id, body=old_body))


async def publish_read_state(db: AsyncSession, channel: Channel, user_id: uuid.UUID) -> None:
    """Tell a DM who just read it (call after the read is committed). No-op for channels."""
    if channel.kind != ChannelKind.dm:
        return
    last = await db.scalar(
        select(ChannelMember.last_read_at).where(
            ChannelMember.channel_id == channel.id, ChannelMember.user_id == user_id
        )
    )
    if last is None:
        return
    await publish_to_channel(
        channel.id,
        {
            "type": "channel.read",
            "channel_id": str(channel.id),
            "user_id": str(user_id),
            "last_read_at": last.isoformat(),
        },
    )


# --- Scheduled messages -----------------------------------------------------------------------


class ScheduledSendError(Exception):
    pass


async def _send_locked(db: AsyncSession, row: ScheduledMessage) -> MessageOut:
    """Post a scheduled message whose row is locked FOR UPDATE in this transaction.

    The status flip commits in the same transaction as the new message, so a row can never be
    sent twice. Raises HTTPException / ScheduledSendError (caller rolls back).
    """
    from app.api.deps import ensure_not_archived, require_channel_access
    from app.api.routes.messages import create_message
    from app.schemas import MessageIn

    user = await db.get(User, row.author_id)
    if not user or not user.is_active:
        raise ScheduledSendError("The author's account is inactive")
    channel = await require_channel_access(row.channel_id, db, user)
    ensure_not_archived(channel)
    data = MessageIn.model_construct(
        body=row.body, parent_id=row.parent_id, attachment_ids=list(row.attachment_ids or [])
    )
    row.status, row.error = "sent", None

    async def link(msg: Message) -> None:
        row.sent_message_id = msg.id

    return await create_message(db, channel, user, data, before_commit=link)


def _failure_reason(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail)[:200]
    if isinstance(exc, ScheduledSendError):
        return str(exc)[:200]
    return "Could not send this message"


def scheduled_event(kind: str, row: ScheduledMessage) -> dict:
    from app.schemas_messaging import ScheduledOut

    return {"type": kind, "scheduled": ScheduledOut.model_validate(row).model_dump(mode="json")}


async def send_scheduled_now(db: AsyncSession, row_id: uuid.UUID) -> MessageOut:
    """Send one (already-locked or lockable) row immediately; errors propagate to the caller."""
    row = await db.scalar(
        select(ScheduledMessage)
        .where(ScheduledMessage.id == row_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Scheduled message not found")
    if row.status not in ("pending", "failed"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"This message is already {row.status}")
    try:
        out = await _send_locked(db, row)
    except ScheduledSendError as e:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    except Exception:
        await db.rollback()
        raise
    await notify_user(row.author_id, scheduled_event("scheduled.sent", row))
    return out


async def deliver_due_scheduled(session_factory=None, limit: int = 200) -> int:
    """Send every due scheduled message once. Safe to run concurrently (SKIP LOCKED)."""
    if session_factory is None:
        from app.core.db import SessionLocal as session_factory
    sent = 0
    for _ in range(limit):
        async with session_factory() as db:
            row = await db.scalar(
                select(ScheduledMessage)
                .where(ScheduledMessage.status == "pending", ScheduledMessage.send_at <= func.now())
                .order_by(ScheduledMessage.send_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if row is None:
                break
            row_id, author_id = row.id, row.author_id
            try:
                await _send_locked(db, row)
                sent += 1
                await notify_user(author_id, scheduled_event("scheduled.sent", row))
            except Exception as e:
                await db.rollback()
                if not isinstance(e, HTTPException | ScheduledSendError):
                    log.exception("Scheduled message %s failed", row_id)
                failed = await db.scalar(
                    select(ScheduledMessage)
                    .where(ScheduledMessage.id == row_id, ScheduledMessage.status == "pending")
                    .with_for_update(skip_locked=True)
                    .execution_options(populate_existing=True)
                )
                if failed is not None:
                    failed.status, failed.error = "failed", _failure_reason(e)
                    await db.commit()
                    await notify_user(author_id, scheduled_event("scheduled.failed", failed))
    return sent


def reserved_attachment_ids():
    """Subquery of upload ids held by pending/failed scheduled messages (orphan sweeper skips them)."""
    return select(func.unnest(ScheduledMessage.attachment_ids)).where(
        ScheduledMessage.status.in_(("pending", "failed"))
    )


# --- Search filters ---------------------------------------------------------------------------

_FILTER_RE = re.compile(r"^(from|in|has|before|after|on|during|is):(.+)$", re.IGNORECASE)
_TOKEN_RE = re.compile(r'"[^"]*"?|\S+')
_HAS = {"link", "file", "image", "pin", "reaction", "attachment", "files", "links", "images",
        "pins", "reactions"}


@dataclass
class SearchQuery:
    text: str = ""
    from_: list[str] = field(default_factory=list)
    in_: list[str] = field(default_factory=list)
    has: set[str] = field(default_factory=set)
    before: date | None = None
    after: date | None = None
    on: date | None = None
    is_thread: bool = False

    @property
    def has_filters(self) -> bool:
        return bool(
            self.from_ or self.in_ or self.has or self.before or self.after or self.on
            or self.is_thread
        )


def _parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_search(q: str) -> SearchQuery:
    sq = SearchQuery()
    words: list[str] = []
    for tok in _TOKEN_RE.findall(q):
        m = _FILTER_RE.match(tok)
        if not m:
            words.append(tok if tok.count('"') != 1 else tok + '"')
            continue
        key, value = m.group(1).lower(), m.group(2)
        if key == "from":
            sq.from_.append(value.lstrip("@"))
        elif key == "in":
            sq.in_.append(value.lstrip("#"))
        elif key == "has" and value.lower() in _HAS:
            sq.has.add({"attachment": "file"}.get(value.lower(), value.lower().rstrip("s")))
        elif key in ("before", "after", "on", "during") and (d := _parse_date(value)):
            setattr(sq, "on" if key == "during" else key, d)
        elif key == "is" and value.lower() in ("thread", "threads"):
            sq.is_thread = True
        else:
            words.append(tok)
    sq.text = " ".join(words).strip()
    return sq


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _day(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=UTC)


async def apply_search_filters(
    db: AsyncSession, stmt, sq: SearchQuery, workspace_id: uuid.UUID, user_id: uuid.UUID
):
    """Add the parsed filters to a `select(Message)` statement."""
    if sq.from_:
        authors: set[uuid.UUID] = set()
        for raw in sq.from_:
            if raw.lower() == "me":
                authors.add(user_id)
            elif uid := _as_uuid(raw):
                authors.add(uid)
            else:
                name = raw.lower().replace(" ", "")
                authors |= set(
                    await db.scalars(
                        select(User.id)
                        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
                        .where(
                            WorkspaceMember.workspace_id == workspace_id,
                            or_(
                                func.replace(func.lower(User.full_name), " ", "").startswith(
                                    name, autoescape=True
                                ),
                                func.lower(User.full_name).startswith(raw.lower(), autoescape=True),
                                func.lower(func.split_part(User.email, "@", 1)) == raw.lower(),
                            ),
                        )
                    )
                )
        stmt = stmt.where(Message.author_id.in_(authors)) if authors else stmt.where(false())
    if sq.in_:
        channels: set[uuid.UUID] = set()
        for raw in sq.in_:
            if cid := _as_uuid(raw):
                channels.add(cid)
            else:
                channels |= set(
                    await db.scalars(
                        select(Channel.id).where(
                            Channel.workspace_id == workspace_id,
                            Channel.name == raw.lower(),
                            Channel.kind != ChannelKind.dm,
                        )
                    )
                )
        stmt = stmt.where(Message.channel_id.in_(channels)) if channels else stmt.where(false())
    if "link" in sq.has:
        stmt = stmt.where(Message.body.op("~*")(r"https?://"))
    if "file" in sq.has:
        stmt = stmt.where(exists().where(Attachment.message_id == Message.id))
    if "image" in sq.has:
        stmt = stmt.where(
            exists().where(
                Attachment.message_id == Message.id, Attachment.content_type.like("image/%")
            )
        )
    if "pin" in sq.has:
        stmt = stmt.where(exists().where(MessagePin.message_id == Message.id))
    if "reaction" in sq.has:
        stmt = stmt.where(exists().where(MessageReaction.message_id == Message.id))
    if sq.before:
        stmt = stmt.where(Message.created_at < _day(sq.before))
    if sq.after:
        stmt = stmt.where(Message.created_at >= _day(sq.after + timedelta(days=1)))
    if sq.on:
        stmt = stmt.where(
            and_(
                Message.created_at >= _day(sq.on),
                Message.created_at < _day(sq.on + timedelta(days=1)),
            )
        )
    if sq.is_thread:
        child = aliased(Message)
        stmt = stmt.where(
            or_(
                Message.parent_id.is_not(None),
                exists().where(child.parent_id == Message.id, child.deleted_at.is_(None)),
            )
        )
    return stmt
