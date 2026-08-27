"""The chip's derived containers, indexed and queryable.

`/v1/nodes` groups the die's 832 names by an authored reading of the names.
This is the other thing: the measured machinery. Twenty-odd derivations walked
out of the switch network -- the ALU as bit slices with its inputs and carry
ends, the status register as one container per flag, the registers as their
closures plus the lines that move each, the timing chain as the cells that
compute each T-state -- composed by `web/chip-groups.js`, the module the
tracer and the chip map draw from, and exported by `tools/export-groups.mjs`.

Two layers, and the difference is the whole point:

  groups      the PARTITION: 132 groups, every one of the 1547 nodes in
              exactly one. A drawing needs disjoint boxes, so ownership goes
              to the most specific claim.
  containers  the same derivations UNFILTERED: 138 of them, overlapping. 122
              nodes are in more than one, and six containers (`sdp:sd1`,
              `sdp:sd2`, `sbus:link`, `dpc:phi1`, `dpc:both`,
              `dpc:unreached`) live only here, absorbed whole by a
              container that outranks them. Asking which groups a node is in
              and getting one answer is a fact about the drawing, not about
              the chip.

Nothing here runs the chip. The die does not change, so every answer is
static and cacheable; the engine is not consulted at all.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent

# Both files are generated (see CLAUDE.md's Commands section) and gitignored.
# The unit runs with the repo root as its working directory, so the defaults
# resolve; the env vars exist for anyone running the service from elsewhere.
GROUPS_PATH = Path(os.environ.get("CHIP_GROUPS", _ROOT / "web" / "groups.json"))
GRAPH_PATH = Path(os.environ.get("CHIP_GRAPH", _ROOT / "web" / "graph.json"))

# A neighbour walk that is not bounded is a way to ask for the whole chip one
# request at a time. Both bounds are reported by /v1/meta.
MAX_DEPTH = 4
MAX_LIMIT = 2000


class AtlasError(RuntimeError):
    """The atlas files are missing or do not agree with each other."""


class Atlas:
    """Loaded once, read many. Every method returns plain dicts."""

    def __init__(self, groups_path: Path = GROUPS_PATH, graph_path: Path = GRAPH_PATH):
        if not groups_path.exists():
            raise AtlasError(
                f"{groups_path} is missing. Build it with:\n"
                "  node tools/export-groups.mjs"
            )
        if not graph_path.exists():
            raise AtlasError(
                f"{graph_path} is missing. Build it with:\n"
                "  cargo run -p v6502-netlist --bin export-graph -- web/graph.json"
            )
        g = json.loads(groups_path.read_text())
        graph = json.loads(graph_path.read_text())

        self.rails: dict[str, int] = graph["rails"]
        self._rail_ids: dict[int, str] = {v: k for k, v in graph["rails"].items()}
        self.format: str = g["format"]
        self.counts: dict = dict(g["counts"])
        self.block_names: list[str] = g["blockNames"]
        self.roles: list[str] = g["roles"]
        self.kinds: list[dict] = g["kinds"]

        self.groups: dict[str, dict] = {x["key"]: x for x in g["groups"]}
        self.containers: dict[str, dict] = {x["key"]: x for x in g["containers"]}
        self.nodes: dict[int, dict] = {x["id"]: x for x in g["nodes"]}
        self.bundles: list[dict] = g["bundles"]

        # Bundles, indexed both ways: a bundle is undirected and both ends
        # want to find it.
        self._bundles_by_group: dict[str, list[dict]] = {k: [] for k in self.groups}
        for b in self.bundles:
            self._bundles_by_group[b["a"]].append(b)
            self._bundles_by_group[b["b"]].append(b)

        # The four ways one node reaches another, kept apart because they are
        # four different relations and collapsing them into "connected" throws
        # away the only structure there is. A gate edge has a direction (an
        # input helps produce an output); a switch channel does not (a pass
        # transistor conducts both ways); a control is a third thing again,
        # neither end of the channel it opens.
        self._drives: dict[int, list[int]] = {}
        self._driven: dict[int, list[int]] = {}
        self._channel: dict[int, list[tuple[int, int, int]]] = {}
        self._controls: dict[int, list[tuple[int, int, int]]] = {}
        for e in graph["edges"]:
            a, b = e["a"], e["b"]
            if e["kind"] == 0:
                self._drives.setdefault(a, []).append(b)
                self._driven.setdefault(b, []).append(a)
            else:
                c, t = e["control"], e["t"]
                self._channel.setdefault(a, []).append((b, c, t))
                self._channel.setdefault(b, []).append((a, c, t))
                self._controls.setdefault(c, []).append((a, b, t))

        # Names. graph.json carries one name per node; the die's table has 832
        # names over 707 nodes, so aliases arrive later from the engine's own
        # NODES table (attach_names) rather than being invented here.
        self._by_name: dict[str, int] = {}
        self._aliases: dict[int, list[str]] = {}
        for n in g["nodes"]:
            if n["name"]:
                self._by_name[n["name"]] = n["id"]
                self._aliases.setdefault(n["id"], []).append(n["name"])

        # The two files have to be about the same chip. A groups.json built
        # against an older graph.json would resolve, quietly, to the wrong
        # centroids and the wrong names.
        for key, grp in self.groups.items():
            for nid in grp["nodes"]:
                if nid not in self.nodes:
                    raise AtlasError(f"{key} names node {nid}, which groups.json does not carry")
        for nid, n in self.nodes.items():
            gn = graph["nodes"][nid] if nid < len(graph["nodes"]) else None
            if gn is None or gn.get("name") != n["name"]:
                raise AtlasError(
                    f"node {nid} is {n['name']!r} in groups.json and "
                    f"{(gn or {}).get('name')!r} in graph.json: rebuild both"
                )

    # -- names ------------------------------------------------------------

    def attach_names(self, name_to_id: dict[str, int]) -> None:
        """Fold in the die's full name table, aliases and all, from the same
        engine response `/v1/nodes` serves. Idempotent."""
        for name, nid in name_to_id.items():
            if name in self._by_name:
                continue
            self._by_name[name] = nid
            if nid in self.nodes:
                self._aliases.setdefault(nid, []).append(name)

    def names_of(self, nid: int) -> list[str]:
        return sorted(self._aliases.get(nid, []))

    def resolve(self, ref: str) -> int:
        """A node by name or by number. Raises KeyError with what was tried."""
        ref = ref.strip()
        if not ref:
            raise KeyError("no node given; pass a die name or a node number")
        if ref in self._by_name:
            return self._by_name[ref]
        # `#1446` is how every page on the site prints an unnamed node, so it
        # is accepted -- url-encoded as %231446, since a bare # is a fragment
        # and never reaches the server.
        if ref.lstrip("#").isdigit():
            nid = int(ref.lstrip("#"))
            if nid in self.nodes:
                return nid
            raise KeyError(f"node {nid} is not in the netlist's live set")
        raise KeyError(f"no node called {ref!r}; try a die name or a node number")

    # -- shaping ----------------------------------------------------------

    def node_brief(self, nid: int) -> dict:
        n = self.nodes[nid]
        return {
            "id": nid,
            "name": n["name"],
            "owner": n["owner"],
            "groups": n["groups"],
        }

    def node_full(self, nid: int) -> dict:
        n = self.nodes[nid]
        return {
            "id": nid,
            "name": n["name"],
            "names": self.names_of(nid),
            "block": n["block"],
            "block_name": self.block_names[n["block"]],
            "drives": n["drives"],
            "drives_name": self.block_names[n["drives"]] if n["drives"] else None,
            "role": self.roles[n["role"]],
            "pullup": n["pullup"],
            "x": n["x"],
            "y": n["y"],
            "owner": n["owner"],
            "owner_label": self.groups[n["owner"]]["label"],
            "groups": [self._container_brief(k) for k in n["groups"]],
            "degree": {
                "drives": len(self._drives.get(nid, [])),
                "driven_by": len(self._driven.get(nid, [])),
                "channel": len(self._channel.get(nid, [])),
                "controls": len(self._controls.get(nid, [])),
            },
        }

    def _container_brief(self, key: str) -> dict:
        c = self.containers[key]
        g = self.groups.get(key)
        return {
            "key": key,
            "kind": c["kind"],
            "label": c["label"],
            "count": c["count"],
            "partitioned": c["partitioned"],
            "parent": g["parent"] if g else c["kind"],
        }

    def group_brief(self, key: str) -> dict:
        g = self.groups[key]
        return {
            "key": key,
            "kind": g["kind"],
            "id": g["id"],
            "label": g["label"],
            "parent": g["parent"],
            "depth": g["depth"],
            "children": g["children"],
            "count": g["count"],
            "blocks": g["blocks"],
        }

    def group_full(self, key: str, members: bool = True, layer: str = "partition") -> dict:
        if layer not in ("partition", "containers"):
            raise ValueError("layer must be partition or containers")
        if key in self.groups:
            g = self.groups[key]
            out = dict(self.group_brief(key))
            out["path"] = g["path"]
            out["partitioned"] = True
            out["overlaps"] = g["overlaps"]
            out["container_count"] = self.containers[key]["count"]
            bundles = sorted(
                self._bundles_by_group[key],
                key=lambda b: -(b["gate"] + b["switch"]),
            )
            out["bundles"] = [self._bundle_from(key, b) for b in bundles]
            nodes = g["nodes"]
        elif key in self.containers:
            # A container the partition absorbed whole: it has members and a
            # kind, and no box on the map. Saying so is better than a 404,
            # because the machinery is real.
            c = self.containers[key]
            out = {
                "key": key,
                "kind": c["kind"],
                "id": c["id"],
                "label": c["label"],
                "parent": c["kind"],
                "depth": 1,
                "children": [],
                "count": c["count"],
                "blocks": [],
                "path": [c["kind"], key],
                "partitioned": False,
                "overlaps": [],
                "container_count": c["count"],
                "bundles": [],
                "absorbed_by": sorted({self.nodes[n]["owner"] for n in c["nodes"]}),
            }
            nodes = c["nodes"]
        else:
            raise KeyError(f"no group called {key!r}")
        # The same key read the other way: the derivation's own node set,
        # before the partition took the overlaps away. `intr:nmi` is 20 nodes
        # as a walk and 18 as a box, because the pipeline latch file outranks
        # the interrupts and keeps `pipeVectorA2`. Both are true and the
        # difference is not a rounding error, so the reader picks.
        if layer == "containers" and key in self.containers:
            nodes = self.containers[key]["nodes"]
            out["count"] = len(nodes)
            out["owned"] = len(self.groups[key]["nodes"]) if key in self.groups else 0
            out["claimed_elsewhere"] = sorted({
                self.nodes[n]["owner"] for n in nodes if self.nodes[n]["owner"] != key
            })
        out["layer"] = layer
        if members:
            out["nodes"] = [self.node_brief(n) for n in nodes]
        return out

    def _bundle_from(self, key: str, b: dict) -> dict:
        far = b["b"] if b["a"] == key else b["a"]
        # ab counts legs whose driving end is bundle.a; report it from the
        # asking group's point of view so "out" always means "out of here".
        out_legs, in_legs = (b["ab"], b["ba"]) if b["a"] == key else (b["ba"], b["ab"])
        return {
            "key": far,
            "label": self.groups[far]["label"],
            "kind": self.groups[far]["kind"],
            "gate": b["gate"],
            "switch": b["switch"],
            "gate_out": out_legs,
            "gate_in": in_legs,
            "controls": b["controls"],
        }

    # -- queries ----------------------------------------------------------

    def list_groups(
        self,
        kind: str | None = None,
        parent: str | None = None,
        block: str | None = None,
        q: str | None = None,
        min_nodes: int = 0,
        layer: str = "partition",
        members: bool = False,
    ) -> list[dict]:
        if layer == "partition":
            keys = list(self.groups)
        elif layer == "containers":
            keys = list(self.containers)
        elif layer == "absorbed":
            keys = [k for k, c in self.containers.items() if not c["partitioned"]]
        else:
            raise ValueError("layer must be partition, containers or absorbed")

        bid = self._block_id(block)
        out = []
        needle = q.lower() if q else None
        for key in keys:
            src = self.groups.get(key) or self.containers[key]
            if kind and src["kind"] != kind:
                continue
            if parent and (self.groups.get(key) or {}).get("parent") != parent:
                continue
            if src["count"] < min_nodes:
                continue
            if needle and needle not in key.lower() and needle not in src["label"].lower():
                continue
            if bid is not None:
                nodes = src["nodes"]
                if not any(self.nodes[n]["block"] == bid for n in nodes):
                    continue
            row = self.group_brief(key) if key in self.groups else self._container_brief(key)
            if members:
                row = dict(row)
                row["nodes"] = [self.node_brief(n) for n in src["nodes"]]
            out.append(row)
        out.sort(key=lambda r: (r["kind"], r["key"]))
        return out

    def list_nodes(
        self,
        group: str | None = None,
        kind: str | None = None,
        block: str | None = None,
        role: str | None = None,
        q: str | None = None,
        named: bool | None = None,
        multi: bool = False,
        limit: int = 500,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        if group is not None:
            src = self.groups.get(group) or self.containers.get(group)
            if src is None:
                raise KeyError(f"no group called {group!r}")
            ids = src["nodes"]
        else:
            ids = list(self.nodes)

        bid = self._block_id(block)
        needle = q.lower() if q else None
        rid = self.roles.index(role) if role in self.roles else None
        if role is not None and rid is None:
            raise ValueError(f"role must be one of {', '.join(self.roles)}")

        hits = []
        for nid in ids:
            n = self.nodes[nid]
            if kind and not any(k.split(":", 1)[0] == kind for k in n["groups"]):
                continue
            if bid is not None and n["block"] != bid:
                continue
            if rid is not None and n["role"] != rid:
                continue
            if named is True and not n["name"]:
                continue
            if named is False and n["name"]:
                continue
            if multi and len(n["groups"]) < 2:
                continue
            if needle:
                hay = (n["name"] or "").lower()
                if needle not in hay and needle != str(nid):
                    continue
            hits.append(nid)
        total = len(hits)
        page = hits[offset : offset + limit]
        return [self.node_full(n) for n in page], total

    def neighbors(
        self,
        nid: int,
        via: str = "all",
        direction: str = "both",
        depth: int = 1,
        limit: int = 200,
    ) -> dict:
        if depth < 1 or depth > MAX_DEPTH:
            raise ValueError(f"depth must be 1..{MAX_DEPTH}")
        if via not in ("all", "gate", "switch", "control"):
            raise ValueError("via must be all, gate, switch or control")
        if direction not in ("both", "in", "out"):
            raise ValueError("direction must be both, in or out")

        seen = {nid: 0}
        found: list[dict] = []
        frontier = [nid]
        truncated = False
        rails = 0
        for d in range(1, depth + 1):
            nxt = []
            for cur in frontier:
                for rel, other, control, t in self._edges_of(cur, via, direction):
                    if other in seen:
                        continue
                    if len(found) >= limit:
                        truncated = True
                        break
                    seen[other] = d
                    # A rail is an endpoint and never a step: vss and vcc
                    # reach hundreds of transistors, and walking through one
                    # would join most of the chip into one answer. It is
                    # reported (a gate leg tied to ground is not a leg that
                    # is missing) and never expanded. Eleven gates really do
                    # take vss as an input, which is the pinout page's
                    # permanently-off pull-up rule.
                    if other in self._rail_ids:
                        rails += 1
                        row = {"id": other, "name": self._rail_ids[other],
                               "owner": None, "groups": [], "rail": True}
                    else:
                        if other not in self.nodes:
                            continue          # outside the netlist's live set
                        row = self.node_brief(other)
                        nxt.append(other)
                    row["relation"] = rel
                    row["from"] = cur
                    row["depth"] = d
                    if control is not None:
                        row["control"] = control
                        row["control_name"] = (self.nodes[control]["name"]
                                               if control in self.nodes else self._rail_ids.get(control))
                        row["transistor"] = t
                    found.append(row)
                if truncated:
                    break
            if truncated:
                break
            frontier = nxt
            if not frontier:
                break

        return {
            "node": self.node_full(nid),
            "via": via,
            "direction": direction,
            "depth": depth,
            "count": len(found),
            "rails": rails,
            "truncated": truncated,
            "neighbors": found,
        }

    def _edges_of(self, nid: int, via: str, direction: str):
        """(relation, other, control, transistor) for one node.

        `drives` and `driven_by` are the two directions of a gate edge and are
        the only pair `direction` applies to: a channel has no direction, and
        a control is not on the path at all -- it opens one.
        """
        if via in ("all", "gate"):
            if direction in ("both", "out"):
                for b in self._drives.get(nid, []):
                    yield ("drives", b, None, None)
            if direction in ("both", "in"):
                for a in self._driven.get(nid, []):
                    yield ("driven_by", a, None, None)
        if via in ("all", "switch"):
            for other, c, t in self._channel.get(nid, []):
                yield ("channel", other, c, t)
        if via in ("all", "control"):
            for a, b, t in self._controls.get(nid, []):
                yield ("opens", a, nid, t)
                yield ("opens", b, nid, t)

    def _block_id(self, block: str | None) -> int | None:
        if block is None:
            return None
        if block.isdigit() and int(block) < len(self.block_names):
            return int(block)
        for i, name in enumerate(self.block_names):
            if name.lower() == block.lower():
                return i
        raise ValueError(f"no block called {block!r}")

    # -- catalogue --------------------------------------------------------

    def overview(self) -> dict:
        return {
            "format": self.format,
            "counts": self.counts,
            "kinds": self.kinds,
            "blocks": [
                {"id": i, "name": n, "nodes": sum(1 for x in self.nodes.values() if x["block"] == i)}
                for i, n in enumerate(self.block_names)
            ],
            "roles": self.roles,
            "limits": {"max_depth": MAX_DEPTH, "max_limit": MAX_LIMIT},
        }
