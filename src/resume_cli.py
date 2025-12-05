#!/usr/bin/env python
"""
CLI helper to resume tile downloads without the browser UI.

Example:
    python resume_cli.py --output-dir output/1763826004296 --source "http://ecn.t0.tiles.virtualearth.net/tiles/a{quad}.jpeg?g=129&mkt=en&stl=H" --threads 4 --resume
"""
import argparse
import json
import math
import os
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from file_writer import FileWriter
from mbtiles_writer import MbtilesWriter
from repo_writer import RepoWriter
from utils import Utils


def writer_by_type(output_type: str):
	if output_type == "mbtiles":
		return MbtilesWriter
	if output_type == "repo":
		return RepoWriter
	return FileWriter


def lat2tile(lat, zoom):
	return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * (2 ** zoom))


def long2tile(lon, zoom):
	return int((lon + 180.0) / 360.0 * (2 ** zoom))


def parse_bounds(bounds):
	if not bounds:
		return None
	if isinstance(bounds, (list, tuple)) and len(bounds) == 4:
		return list(map(float, bounds))
	try:
		parts = list(map(float, bounds.split(",")))
		if len(parts) == 4:
			return parts
	except Exception:
		pass
	return None


def load_metadata(base_dir: str):
	"""Load metadata from metadata.json or mbtiles/repo file."""
	meta = {
		"outputType": "directory",
		"outputFile": "{z}/{x}/{y}.png",
		"outputScale": None,
		"source": None,
		"bounds": None,
		"center": None,
		"minZoom": None,
		"maxZoom": None,
		"tileSize": None,
		"timestamp": None,
	}

	mbtiles_files = [f for f in os.listdir(base_dir) if f.endswith(".mbtiles")]
	repo_files = [f for f in os.listdir(base_dir) if f.endswith(".repo")]
	metadata_json = os.path.join(base_dir, "metadata.json")

	meta_source = None
	if mbtiles_files:
		meta_source = os.path.join(base_dir, mbtiles_files[0])
		meta["outputType"] = "mbtiles"
		meta["outputFile"] = mbtiles_files[0]
	elif repo_files:
		meta_source = os.path.join(base_dir, repo_files[0])
		meta["outputType"] = "repo"
		meta["outputFile"] = repo_files[0]
	elif os.path.isfile(metadata_json):
		meta_source = metadata_json

	if not meta_source:
		return meta

	try:
		if meta_source.endswith(".json"):
			with open(meta_source, "r", encoding="utf-8") as f:
				data = json.load(f)
		else:
			data = {}
			conn = sqlite3.connect(meta_source, check_same_thread=False)
			cur = conn.cursor()
			cur.execute("SELECT name, value FROM metadata")
			for name, value in cur.fetchall():
				data[name] = value
			conn.close()

		meta["bounds"] = parse_bounds(data.get("bounds"))
		meta["center"] = parse_bounds(data.get("center"))
		meta["minZoom"] = int(data["minzoom"]) if data.get("minzoom") is not None else None
		meta["maxZoom"] = int(data["maxzoom"]) if data.get("maxzoom") is not None else None
		meta["tileSize"] = int(data["tilesize"]) if data.get("tilesize") is not None else None

		# extra metadata keys we store in newer versions
		meta["outputType"] = data.get("output_type", meta["outputType"])
		meta["outputFile"] = data.get("output_file", meta.get("outputFile"))
		meta["outputScale"] = int(data["output_scale"]) if data.get("output_scale") is not None else None
		meta["source"] = data.get("source")
		meta["timestamp"] = data.get("timestamp")

		# fallback for older metadata where name was the file pattern
		if data.get("name") and meta["outputFile"] is None:
			meta["outputFile"] = data["name"]

	except Exception as exc:
		print(f"Warning: failed to read metadata from {meta_source}: {exc}")

	return meta


def build_tile_list(bounds, min_zoom, max_zoom):
	tiles = []
	min_lon, min_lat, max_lon, max_lat = bounds

	for z in range(min_zoom, max_zoom + 1):
		x_start = long2tile(min_lon, z)
		x_end = long2tile(max_lon, z)
		y_start = lat2tile(max_lat, z)
		y_end = lat2tile(min_lat, z)

		for x in range(x_start, x_end + 1):
			for y in range(y_start, y_end + 1):
				tiles.append((x, y, z))

	return tiles


def format_output_path(base_dir, output_file, x, y, z, quad):
	replace_map = {
		"{x}": str(x),
		"{y}": str(y),
		"{z}": str(z),
		"{quad}": quad,
	}

	path = output_file
	for key, value in replace_map.items():
		path = path.replace(key, value)

	return os.path.join(base_dir, path)


def download_tiles(args):
	lock = threading.Lock()
	meta = load_metadata(args.output_dir)

	output_type = args.output_type or meta["outputType"]
	output_file = args.output_file or meta["outputFile"]
	output_scale = args.output_scale or meta["outputScale"] or (max(1, meta["tileSize"] // 256) if meta["tileSize"] else 1)
	min_zoom = args.min_zoom if args.min_zoom is not None else meta["minZoom"]
	max_zoom = args.max_zoom if args.max_zoom is not None else meta["maxZoom"]
	source = args.source or meta["source"]

	if min_zoom is None or max_zoom is None or not meta["bounds"]:
		raise SystemExit("Missing bounds or zoom levels in metadata. Please provide --min-zoom, --max-zoom, and ensure metadata has bounds.")

	if not source:
		raise SystemExit("Tile source URL is required. Provide --source.")

	tiles = build_tile_list(meta["bounds"], min_zoom, max_zoom)
	writer = writer_by_type(output_type)

	print(f"Found {len(tiles):,} tiles to consider across zoom {min_zoom}-{max_zoom}")
	print(f"Output type: {output_type}, scale: {output_scale}, file pattern: {output_file}")
	print(f"Resume mode: {'on' if args.resume else 'off'}; Threads: {args.threads}")

	def worker(x, y, z):
		quad = Utils.makeQuadKey(x, y, z)
		target_path = format_output_path(args.output_dir, output_file, x, y, z, quad)

		if args.resume and writer.exists(target_path, x, y, z):
			return (x, y, z, "skip")

		temp_file = os.path.join("temp", f"{uuid.uuid4().hex}.png")

		for attempt in range(1, args.retries + 1):
			code = Utils.downloadFileScaled(source, temp_file, x, y, z, output_scale)
			if code == 200:
				writer.addTile(lock, target_path, temp_file, x, y, z, output_scale)
				try:
					os.remove(temp_file)
				except OSError:
					pass
				return (x, y, z, "ok")
			if attempt == args.retries:
				try:
					os.remove(temp_file)
				except OSError:
					pass
				return (x, y, z, f"error {code}")

	results = {"ok": 0, "skip": 0, "error": 0}

	with ThreadPoolExecutor(max_workers=args.threads) as executor:
		future_map = {executor.submit(worker, x, y, z): (x, y, z) for x, y, z in tiles}
		for future in as_completed(future_map):
			x, y, z = future_map[future]
			try:
				_, _, _, status = future.result()
				results[status] = results.get(status, 0) + 1
			except Exception as exc:
				print(f"[{x},{y},{z}] failed: {exc}")
				results["error"] = results.get("error", 0) + 1

	print(f"Done. ok={results.get('ok',0)}, skipped={results.get('skip',0)}, errors={results.get('error',0)}")


def main():
	parser = argparse.ArgumentParser(description="Resume tile download from an existing output directory.")
	parser.add_argument("--output-dir", required=True, help="Path to existing output directory (e.g. output/1763826004296)")
	parser.add_argument("--source", help="Tile URL template (required if not stored in metadata)")
	parser.add_argument("--threads", type=int, default=4, help="Parallel download threads")
	parser.add_argument("--resume", action="store_true", help="Skip tiles that already exist")
	parser.add_argument("--retries", type=int, default=3, help="Retries per tile when a download fails")
	parser.add_argument("--min-zoom", type=int, help="Override min zoom")
	parser.add_argument("--max-zoom", type=int, help="Override max zoom")
	parser.add_argument("--output-type", choices=["directory", "mbtiles", "repo"], help="Override output type")
	parser.add_argument("--output-file", help="Override output file pattern/name (e.g. {z}/{x}/{y}.png or tiles.mbtiles)")
	parser.add_argument("--output-scale", type=int, help="Override output scale (1 or 2)")
	args = parser.parse_args()

	download_tiles(args)


if __name__ == "__main__":
	main()
