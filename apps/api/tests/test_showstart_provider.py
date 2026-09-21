import asyncio

import httpx
import pytest

from app.providers.concert import ProviderHealthState
from app.providers.concert_experimental import ShowStartProvider
from app.providers.errors import ProviderTemporarilyUnavailable

LIST_HTML = """
<a href="/event/307832" class="show-item item">
  <div class="title">2026天目山音乐节</div>
  <div class="artist">艺人：胡彦斌/Mola Oddity（莫拉怪乐）</div>
  <div class="time">时间：2026/10/02 13:30</div>
  <div class="addr"><i></i>[杭州]杭州临安区天目未来谷</div>
</a>
<script>listData:[{id:307832,title:"2026天目山音乐节",poster:"https:\u002F\u002Fs2.showstart.com\u002Fposter.jpg"}]</script>
"""

DETAIL_HTML = """
<div class="title">2026天目山音乐节</div>
<p>演出时间：10月02日 13:30-10月02日 21:45</p>
<p>艺人： <a href="/artist/1">胡彦斌<span>/</span></a><a href="/artist/2">Mola Oddity（莫拉怪乐）</a></p>
<p>场地： <a href="/venue/3">杭州 杭州临安区天目未来谷</a></p>
<p>地址：浙江省杭州市临安区於潜镇天目未来谷 <span>查看地图</span></p>
<script>window.__NUXT__={data:[{detail:{title:"2026天目山音乐节",poster:"https:\u002F\u002Fs2.showstart.com\u002Fdetail.jpg"},longitude:119.459134,latitude:30.241225,cityName:"杭州",address:"浙江省杭州市临安区於潜镇天目未来谷"}]}</script>
"""


def test_public_search_html_maps_only_normalized_fields() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["keyword"] == "天目山"
        return httpx.Response(200, text=LIST_HTML)

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://showstart.test"
        ) as client:
            provider = ShowStartProvider(enabled=True, client=client, min_interval_seconds=0)
            return await provider.search_events(query="天目山", page_budget=1)

    events = asyncio.run(run())
    assert len(events) == 1
    assert events[0].provider_event_id == "307832"
    assert events[0].start_date.isoformat() == "2026-10-02"
    assert str(events[0].start_time) == "13:30:00"
    assert events[0].venue.city == "杭州"
    assert events[0].artwork_url == "https://s2.showstart.com/poster.jpg"
    assert [value.name for value in events[0].performers] == ["胡彦斌", "Mola Oddity（莫拉怪乐）"]


def test_public_search_rejects_provider_fuzzy_false_positives() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=LIST_HTML)

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://showstart.test"
        ) as client:
            provider = ShowStartProvider(enabled=True, client=client, min_interval_seconds=0)
            return await provider.search_events(query="Ado", page_budget=1)

    assert asyncio.run(run()) == []


def test_public_detail_enriches_search_identity_without_inventing_date() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=DETAIL_HTML if request.url.path.endswith("307832") else LIST_HTML)

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://showstart.test"
        ) as client:
            provider = ShowStartProvider(enabled=True, client=client, min_interval_seconds=0)
            return await provider.get_event("307832")

    event = asyncio.run(run())
    assert event.start_date.isoformat() == "2026-10-02"
    assert event.venue.address == "浙江省杭州市临安区於潜镇天目未来谷"
    assert event.venue.latitude == 30.241225
    assert event.venue.longitude == 119.459134
    assert event.artwork_url == "https://s2.showstart.com/detail.jpg"


@pytest.mark.parametrize("status", [403, 404])
def test_public_html_block_stops_without_bypass(status: int) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="blocked")

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://showstart.test"
        ) as client:
            provider = ShowStartProvider(enabled=True, client=client, min_interval_seconds=0)
            with pytest.raises(ProviderTemporarilyUnavailable):
                await provider.search_events(query="milet")
            return provider.health()

    assert asyncio.run(run()).state == ProviderHealthState.UNAVAILABLE


def test_enabled_public_provider_starts_healthy_until_a_real_request_changes_health() -> None:
    assert ShowStartProvider(enabled=True).health().state.value == "HEALTHY"
    assert ShowStartProvider(enabled=False).health().state.value == "NOT_CONFIGURED"
