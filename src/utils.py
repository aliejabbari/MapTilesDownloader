#!/usr/bin/env python

from urllib.parse import urlparse
from urllib.parse import parse_qs
from urllib.parse import parse_qsl
import urllib.request
import cgi
import uuid
import random
import string
from cgi import parse_header, parse_multipart
import argparse
import uuid
import random
import time
import json
import shutil
import ssl
import glob
import os
import base64
import math

from PIL import Image

class Utils:
	
	@staticmethod
	def randomString():
		return uuid.uuid4().hex.upper()[0:6]

	@staticmethod
	def build_request(url):
		# Use a browser-like header to avoid 403 blocks from providers like Google
		headers = {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
			"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		}

		# Some providers (Google) expect a maps referrer to avoid HTTP 403
		if "google" in url.lower():
			headers["Referer"] = "https://www.google.com/maps"

		return urllib.request.Request(url, headers=headers)

	@staticmethod
	def open_url(url):
		request = Utils.build_request(url)
		return urllib.request.urlopen(request, context=ssl._create_unverified_context())

	def getChildTiles(x, y, z):
		childX = x * 2
		childY = y * 2
		childZ = z + 1

		return [
			(childX, childY, childZ),
			(childX+1, childY, childZ),
			(childX+1, childY+1, childZ),
			(childX, childY+1, childZ),
		]

	def makeQuadKey(tile_x, tile_y, level):
		quadkey = ""
		for i in range(level):
			bit = level - i
			digit = ord('0')
			mask = 1 << (bit - 1)  # if (bit - 1) > 0 else 1 >> (bit - 1)
			if (tile_x & mask) != 0:
				digit += 1
			if (tile_y & mask) != 0:
				digit += 2
			quadkey += chr(digit)
		return quadkey

	@staticmethod
	def num2deg(xtile, ytile, zoom):
		n = 2.0 ** zoom
		lon_deg = xtile / n * 360.0 - 180.0
		lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * ytile / n)))
		lat_deg = math.degrees(lat_rad)
		return (lat_deg, lon_deg)

	@staticmethod
	def qualifyURL(url, x, y, z):

		scale22 = 23 - (z * 2)

		replaceMap = {
			"x": str(x),
			"y": str(y),
			"z": str(z),
			"scale:22": str(scale22),
			"quad": Utils.makeQuadKey(x, y, z),
		}

		for key, value in replaceMap.items():
			newKey = str("{" + str(key) + "}")
			url = url.replace(newKey, value)

		return url

	@staticmethod
	def mergeQuadTile(quadTiles):

		width = 0
		height = 0

		for tile in quadTiles:
			if(tile is not None):
				width = quadTiles[0].size[0] * 2
				height = quadTiles[1].size[1] * 2
				break

		if width == 0 or height == 0:
			return None

		canvas = Image.new('RGB', (width, height))

		if quadTiles[0] is not None:
			canvas.paste(quadTiles[0], box=(0,0))

		if quadTiles[1] is not None:
			canvas.paste(quadTiles[1], box=(width - quadTiles[1].size[0], 0))

		if quadTiles[2] is not None:
			canvas.paste(quadTiles[2], box=(width - quadTiles[2].size[0], height - quadTiles[2].size[1]))

		if quadTiles[3] is not None:
			canvas.paste(quadTiles[3], box=(0, height - quadTiles[3].size[1]))

		return canvas

	@staticmethod
	def downloadFile(url, destination, x, y, z):

		url = Utils.qualifyURL(url, x, y, z)

		code = 0

		try:
			with Utils.open_url(url) as response:
				code = response.getcode()
				if code != 200:
					return code

				directory = os.path.dirname(destination)
				if directory != "":
					os.makedirs(directory, exist_ok=True)

				with open(destination, "wb") as out_file:
					out_file.write(response.read())
		except urllib.error.HTTPError as e:
			code = e.code
		except urllib.error.URLError as e:
			print(e)
			code = -1

		return code


	@staticmethod
	def downloadFileScaled(url, destination, x, y, z, outputScale):

		if outputScale == 1:
			return Utils.downloadFile(url, destination, x, y, z)

		elif outputScale == 2:

			childTiles = Utils.getChildTiles(x, y, z)
			childImages = []

			for childX, childY, childZ in childTiles:
				
				tempFile = Utils.randomString() + ".png"
				tempFilePath = os.path.join("temp", tempFile)

				code = Utils.downloadFile(url, tempFilePath, childX, childY, childZ)

				if code == 200:
					image = Image.open(tempFilePath)
				else:
					return code

				childImages.append(image)
			
			canvas = Utils.mergeQuadTile(childImages)
			canvas.save(destination, "PNG")
			
			return 200

		#TODO implement custom scale

			



