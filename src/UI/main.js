var mapView;

$(function() {

	var map = null;
	var draw = null;
	var geocoder = null;
	var bar = null;
	var rectangleDrawingActive = false;
	var rectangleFirstCorner = null;

	var cancellationToken = null;
	var requests = [];

	var sources = {

		"🗺️ Bing Maps Road": "http://ecn.t0.tiles.virtualearth.net/tiles/r{quad}.jpeg?g=129&mkt=en&stl=H",
		"🛰️ Bing Maps Satellite": "http://ecn.t0.tiles.virtualearth.net/tiles/a{quad}.jpeg?g=129&mkt=en&stl=H",
		"🏙️ Bing Maps Hybrid": "http://ecn.t0.tiles.virtualearth.net/tiles/h{quad}.jpeg?g=129&mkt=en&stl=H",

		"div-1B": "",

		"📍 Google Maps (Download Only)": "https://mt0.google.com/vt?lyrs=m&x={x}&s=&y={y}&z={z}",
		"🛰️ Google Maps Satellite (Download Only)": "https://mt0.google.com/vt?lyrs=s&x={x}&s=&y={y}&z={z}",
		"🏙️ Google Maps Hybrid (Download Only)": "https://mt0.google.com/vt?lyrs=h&x={x}&s=&y={y}&z={z}",
		"🏔️ Google Maps Terrain (Download Only)": "https://mt0.google.com/vt?lyrs=p&x={x}&s=&y={y}&z={z}",

		"div-2": "",

		"🗺️ Open Street Maps": "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
		"🚴 Open Cycle Maps": "http://a.tile.opencyclemap.org/cycle/{z}/{x}/{y}.png",
		"🚌 Open PT Transport": "http://openptmap.org/tiles/{z}/{x}/{y}.png",

		"div-3": "",

		"🛰️ ESRI World Imagery": "http://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
		"📚 Wikimedia Maps": "https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png",
		"🚀 NASA GIBS": "https://map1.vis.earthdata.nasa.gov/wmts-webmerc/MODIS_Terra_CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",

		"div-4": "",

		"💡 Carto Light": "http://cartodb-basemaps-c.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png",
		"🎨 Stamen Toner B&W": "http://a.tile.stamen.com/toner/{z}/{x}/{y}.png",

	};

	function initializeMap() {

		mapboxgl.accessToken = ''; // not needed for the custom raster style below

		// Simple OSM-based raster style so the map renders without Mapbox tokens
		map = new mapboxgl.Map({
			container: 'map-view',
			style: {
				"version": 8,
				"glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
				"sprite": "https://demotiles.maplibre.org/styles/osm-bright-gl-style/sprite",
				"sources": {
					"base-osm": {
						"type": "raster",
						"tiles": ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
						"tileSize": 256,
						"attribution": "© OpenStreetMap contributors"
					}
				},
				"layers": [
					{
						"id": "base-osm",
						"type": "raster",
						"source": "base-osm"
					}
				]
			},
			center: [-73.983652, 40.755024],
			zoom: 12
		});

		map.on('load', function() {
			// Initialize with the default Bing Maps source (skip Google Maps due to CORS)
			var defaultUrl = $("#source-box").val();
			if (defaultUrl && !defaultUrl.includes('google.com')) {
				switchMapSource(defaultUrl, "Bing Maps Satellite");
			}

			initializeRectangleTool(true); // ensure draw is set up after style is ready
		});

		geocoder = new MapboxGeocoder({ accessToken: mapboxgl.accessToken });
		try {
			var control = map.addControl(geocoder);
		} catch (e) {
			console.warn("Geocoder failed to initialize (likely missing token). Search box will be disabled.", e);
		}
	}

	function initializeMaterialize() {
		$('select').formSelect();
		$('.dropdown-trigger').dropdown({
			constrainWidth: false,
		});
		$('.tooltipped').tooltip();
	}

	function initializeSources() {

		var dropdown = $("#sources");

		for(var key in sources) {
			var url = sources[key];

			if(url == "") {
				dropdown.append("<hr/>");
				continue;
			}

			var item = $("<li><a></a></li>");
			item.attr("data-url", url);
			item.attr("data-name", key);
			item.find("a").text(key);

			item.click(function() {
				var url = $(this).attr("data-url");
				var name = $(this).attr("data-name");
				$("#source-box").val(url);
				switchMapSource(url, name);
			})

			dropdown.append(item);
		}
	}

	function initializeSearch() {
		$("#search-form").submit(function(e) {
			var location = $("#location-box").val();
			geocoder.query(location);

			e.preventDefault();
		})

		// Auto-switch map source when URL is manually entered
		$("#source-box").on('change input', function() {
			var url = $(this).val();
			if (url && url.trim() !== "") {
				switchMapSource(url, "Custom Source");
			}
		});
	}

	function initializeMoreOptions() {

		$("#more-options-toggle").click(function() {
			$("#more-options").toggle();
		})

		var outputFileBox = $("#output-file-box")
		$("#output-type").change(function() {
			var outputType = $("#output-type").val();
			if(outputType == "mbtiles") {
				outputFileBox.val("tiles.mbtiles")
			} else if(outputType == "repo") {
				outputFileBox.val("tiles.repo")
			} else if(outputType == "directory") {
				outputFileBox.val("{z}/{x}/{y}.png")
			}
		})

	}

	function switchMapSource(url, name) {
		if (!url || url === "") return;

		// If style isn't ready yet, wait for the load event then retry
		if (!map || !map.isStyleLoaded()) {
			map.once('load', function() {
				switchMapSource(url, name);
			});
			return;
		}

		var requiresProxy = url.includes('google.com') || url.includes('googleapis.com') || url.includes('{quad}');

		// Remove existing custom source if it exists
		if (map.getSource('custom-tiles')) {
			map.removeLayer('custom-tiles');
			map.removeSource('custom-tiles');
		}

		// Convert different tile URL formats to Mapbox GL JS format
		var tileUrl = url;

		// Use local proxy for Google tiles or quadkey-based providers to bypass CORS and format issues
		if (requiresProxy) {
			var encoded = encodeURIComponent(url);
			tileUrl = "/tile-proxy?x={x}&y={y}&z={z}&url=" + encoded;

			if (url.includes('google')) {
				M.toast({
					html: 'Proxying Google tiles locally so they can be previewed.',
					displayLength: 4000
				});
			}
		}

		try {
			// Add the custom tile source
			map.addSource('custom-tiles', {
				'type': 'raster',
				'tiles': [tileUrl],
				'tileSize': 256,
				'attribution': name
			});

			// Add the tile layer
			var beforeLayer = map.getLayer('waterway-label') ? 'waterway-label' : null;
			var customLayer = {
				'id': 'custom-tiles',
				'type': 'raster',
				'source': 'custom-tiles',
				'paint': {}
			};

			if (beforeLayer) {
				map.addLayer(customLayer, beforeLayer);
			} else {
				map.addLayer(customLayer);
			}

			M.toast({html: 'Viewing: ' + name, displayLength: 2000});

		} catch (error) {
			console.error('Error switching map source:', error);
			console.error('Failed URL:', tileUrl);

			// Provide more specific error messages
			let errorMsg = 'Error loading ' + name + ' tiles';
			if (error.message) {
				errorMsg += ': ' + error.message;
			}

			M.toast({html: errorMsg, displayLength: 4000});

			// Try to fall back to the default Mapbox style
			try {
				if (map.getSource('custom-tiles')) {
					map.removeLayer('custom-tiles');
					map.removeSource('custom-tiles');
				}
				M.toast({html: 'Falling back to default map style', displayLength: 2000});
			} catch (fallbackError) {
				console.error('Fallback error:', fallbackError);
			}
		}
	}

	function initializeRectangleTool(force) {

		if (!map) {
			return;
		}

		// if map style not yet loaded, postpone initialization
		if (!force && !map.isStyleLoaded()) {
			map.once('load', function() {
				initializeRectangleTool(true);
			});
			return;
		}

		if (draw) {
			return; // already initialized
		}

		var modes = MapboxDraw.modes;
		modes.draw_rectangle = DrawRectangle.default;

		draw = new MapboxDraw({
			modes: modes
		});
		map.addControl(draw);

		map.on('draw.create', function (e) {
			M.Toast.dismissAll();
		});

		$("#rectangle-draw-button").click(function() {
			startDrawing();
		})

	}

	function startDrawing() {
		if (!draw) {
			M.toast({html: 'Map is still loading, please try again in a moment.', displayLength: 3000});
			return;
		}

		if (!map.isStyleLoaded()) {
			map.once('load', startDrawing);
			return;
		}

		removeGrid();
		draw.deleteAll();

		rectangleDrawingActive = true;
		rectangleFirstCorner = null;
		map.getCanvas().style.cursor = 'crosshair';
		try { map.doubleClickZoom.disable(); } catch(e){}

		M.Toast.dismissAll();
		M.toast({html: 'Click the first corner, then the opposite corner to create a rectangle.', displayLength: 7000});
	}

	function rectangleClickHandler(e) {
		if (!rectangleDrawingActive) {
			return;
		}

		if (!rectangleFirstCorner) {
			rectangleFirstCorner = e.lngLat;
			M.Toast.dismissAll();
			M.toast({html: 'Now click the opposite corner.', displayLength: 5000});
			return;
		}

		var c1 = rectangleFirstCorner;
		var c2 = e.lngLat;

		// Build rectangle coordinates
		var coords = [
			[c1.lng, c1.lat],
			[c2.lng, c1.lat],
			[c2.lng, c2.lat],
			[c1.lng, c2.lat],
			[c1.lng, c1.lat],
		];

		draw.deleteAll();
		draw.add({
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [coords]
			}
		});

		rectangleDrawingActive = false;
		rectangleFirstCorner = null;
		map.getCanvas().style.cursor = '';
		try { map.doubleClickZoom.enable(); } catch(e){}

		M.Toast.dismissAll();
		M.toast({html: 'Region selected. You can preview grid or download now.', displayLength: 5000});
	}

	function initializeGridPreview() {
		$("#grid-preview-button").click(previewGrid);

		map.on('click', showTilePopup);
		map.on('click', rectangleClickHandler);
	}

	function showTilePopup(e) {

		if(!e.originalEvent.ctrlKey) {
			return;
		}

		var maxZoom = getMaxZoom();

		var x = lat2tile(e.lngLat.lat, maxZoom);
		var y = long2tile(e.lngLat.lng, maxZoom);

		var content = "X, Y, Z<br/><b>" + x + ", " + y + ", " + maxZoom + "</b><hr/>";
		content += "Lat, Lng<br/><b>" + e.lngLat.lat + ", " + e.lngLat.lng + "</b>";

        new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(content)
            .addTo(map);

        console.log(e.lngLat)

	}

	function long2tile(lon,zoom) {
		return (Math.floor((lon+180)/360*Math.pow(2,zoom)));
	}

	function lat2tile(lat,zoom)  {
		return (Math.floor((1-Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180))/Math.PI)/2 *Math.pow(2,zoom)));
	}

	function tile2long(x,z) {
		return (x/Math.pow(2,z)*360-180);
	}

	function tile2lat(y,z) {
		var n=Math.PI-2*Math.PI*y/Math.pow(2,z);
		return (180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))));
	}

	function getTileRect(x, y, zoom) {

		var c1 = new mapboxgl.LngLat(tile2long(x, zoom), tile2lat(y, zoom));
		var c2 = new mapboxgl.LngLat(tile2long(x + 1, zoom), tile2lat(y + 1, zoom));

		return new mapboxgl.LngLatBounds(c1, c2);
	}

	function getMinZoom() {
		return Math.min(parseInt($("#zoom-from-box").val()), parseInt($("#zoom-to-box").val()));
	}

	function getMaxZoom() {
		return Math.max(parseInt($("#zoom-from-box").val()), parseInt($("#zoom-to-box").val()));
	}

	function getArrayByBounds(bounds) {

		var tileArray = [
			[ bounds.getSouthWest().lng, bounds.getNorthEast().lat ],
			[ bounds.getNorthEast().lng, bounds.getNorthEast().lat ],
			[ bounds.getNorthEast().lng, bounds.getSouthWest().lat ],
			[ bounds.getSouthWest().lng, bounds.getSouthWest().lat ],
			[ bounds.getSouthWest().lng, bounds.getNorthEast().lat ],
		];

		return tileArray;
	}

	function getPolygonByBounds(bounds) {

		var tilePolygonData = getArrayByBounds(bounds);

		var polygon = turf.polygon([tilePolygonData]);

		return polygon;
	}

	function isTileInSelection(tileRect) {

		var polygon = getPolygonByBounds(tileRect);

		var areaPolygon = draw.getAll().features[0];

		if(turf.booleanDisjoint(polygon, areaPolygon) == false) {
			return true;
		}

		return false;
	}

	function getBounds() {

		if(draw.getAll().features.length === 0) {
			return null;
		}

		var coordinates = draw.getAll().features[0].geometry.coordinates[0];

		var bounds = coordinates.reduce(function(bounds, coord) {
			return bounds.extend(coord);
		}, new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));

		return bounds;
	}

	function getGrid(zoomLevel) {

		var bounds = getBounds();
		if (!bounds) {
			return [];
		}

		var rects = [];

		var outputScale = $("#output-scale").val();
		//var thisZoom = zoomLevel - (outputScale-1)
		var thisZoom = zoomLevel

		var TY    = lat2tile(bounds.getNorthEast().lat, thisZoom);
		var LX   = long2tile(bounds.getSouthWest().lng, thisZoom);
		var BY = lat2tile(bounds.getSouthWest().lat, thisZoom);
		var RX  = long2tile(bounds.getNorthEast().lng, thisZoom);

		for(var y = TY; y <= BY; y++) {
			for(var x = LX; x <= RX; x++) {

				var rect = getTileRect(x, y, thisZoom);

				if(isTileInSelection(rect)) {
					rects.push({
						x: x,
						y: y,
						z: thisZoom,
						rect: rect,
					});
				}

			}
		}

		return rects
	}

	function getAllGridTiles() {
		var allTiles = [];

		for(var z = getMinZoom(); z <= getMaxZoom(); z++) {
			var grid = getGrid(z);
			// TODO shuffle grid via a heuristic (hamlet curve? :/)
			allTiles = allTiles.concat(grid);
		}

		return allTiles;
	}

	function removeGrid() {
		removeLayer("grid-preview");
	}

	function previewGrid() {

		if(draw.getAll().features.length === 0) {
			M.toast({html: 'Draw a rectangle first.', displayLength: 3000});
			return;
		}

		var maxZoom = getMaxZoom();
		var grid = getGrid(maxZoom);

		var pointsCollection = []

		for(var i in grid) {
			var feature = grid[i];
			var array = getArrayByBounds(feature.rect);
			pointsCollection.push(array);
		}

		removeGrid();

		map.addLayer({
			'id': "grid-preview",
			'type': 'line',
			'source': {
				'type': 'geojson',
				'data': turf.polygon(pointsCollection),
			},
			'layout': {},
			'paint': {
				"line-color": "#fa8231",
				"line-width": 3,
			}
		});

		var totalTiles = getAllGridTiles().length;
		M.toast({html: 'Total ' + totalTiles.toLocaleString() + ' tiles in the region.', displayLength: 5000})

	}

	function previewRect(rectInfo) {

		var array = getArrayByBounds(rectInfo.rect);

		var id = "temp-" + rectInfo.x + '-' + rectInfo.y + '-' + rectInfo.z;

		map.addLayer({
			'id': id,
			'type': 'line',
			'source': {
				'type': 'geojson',
				'data': turf.polygon([array]),
			},
			'layout': {},
			'paint': {
				"line-color": "#ff9f1a",
				"line-width": 3,
			}
		});

		return id;
	}

	function removeLayer(id) {
		if(map.getSource(id) != null) {
			map.removeLayer(id);
			map.removeSource(id);
		}
	}

	function generateQuadKey(x, y, z) {
	    var quadKey = [];
	    for (var i = z; i > 0; i--) {
	        var digit = '0';
	        var mask = 1 << (i - 1);
	        if ((x & mask) != 0) {
	            digit++;
	        }
	        if ((y & mask) != 0) {
	            digit++;
	            digit++;
	        }
	        quadKey.push(digit);
	    }
	    return quadKey.join('');
	}

	function initializeDownloader() {

		bar = new ProgressBar.Circle($('#progress-radial').get(0), {
			strokeWidth: 12,
			easing: 'easeOut',
			duration: 200,
			trailColor: '#eee',
			trailWidth: 1,
			from: {color: '#0fb9b1', a:0},
			to: {color: '#20bf6b', a:1},
			svgStyle: null,
			step: function(state, circle) {
				circle.path.setAttribute('stroke', state.color);
			}
		});

		$("#download-button").click(startDownloading)
		$("#stop-button").click(stopDownloading)

		var timestamp = Date.now().toString();
		//$("#output-directory-box").val(timestamp)
	}

	function showTinyTile(base64) {
		var currentImages = $(".tile-strip img");

		for(var i = 4; i < currentImages.length; i++) {
			$(currentImages[i]).remove();
		}

		var image = $("<img/>").attr('src', "data:image/png;base64, " + base64)

		var strip = $(".tile-strip");
		strip.prepend(image)
	}

	async function startDownloading() {

		if(draw.getAll().features.length === 0) {
			M.toast({html: 'You need to select a region first.', displayLength: 3000});
			return;
		}

		if(draw.getAll().features.length == 0) {
			M.toast({html: 'You need to select a region first.', displayLength: 3000})
			return;
		}

		cancellationToken = false; 
		requests = [];

		$("#main-sidebar").hide();
		$("#download-sidebar").show();
		$(".tile-strip").html("");
		$("#stop-button").html("STOP");
		removeGrid();
		clearLogs();
		M.Toast.dismissAll();

		var timestamp = Date.now().toString();

		var allTiles = getAllGridTiles();
		updateProgress(0, allTiles.length);

		var numThreads = parseInt($("#parallel-threads-box").val());
		var outputDirectory = $("#output-directory-box").val();
		var outputFile = $("#output-file-box").val();
		var outputType = $("#output-type").val();
		var outputScale = $("#output-scale").val();
		var source = $("#source-box").val()

		var bounds = getBounds();
		var boundsArray = [bounds.getSouthWest().lng, bounds.getSouthWest().lat, bounds.getNorthEast().lng, bounds.getNorthEast().lat]
		var centerArray = [bounds.getCenter().lng, bounds.getCenter().lat, getMaxZoom()]
		
		var data = new FormData();
		data.append('minZoom', getMinZoom())
		data.append('maxZoom', getMaxZoom())
		data.append('outputDirectory', outputDirectory)
		data.append('outputFile', outputFile)
		data.append('outputType', outputType)
		data.append('outputScale', outputScale)
		data.append('source', source)
		data.append('timestamp', timestamp)
		data.append('bounds', boundsArray.join(","))
		data.append('center', centerArray.join(","))

		var request = await $.ajax({
			url: "/start-download",
			async: true,
			timeout: 30 * 1000,
			type: "post",
			contentType: false,
			processData: false,
			data: data,
			dataType: 'json',
		})

		let i = 0;
		var iterator = async.eachLimit(allTiles, numThreads, function(item, done) {

			if(cancellationToken) {
				return;
			}

			var boxLayer = previewRect(item);

			var url = "/download-tile";

			var data = new FormData();
			data.append('x', item.x)
			data.append('y', item.y)
			data.append('z', item.z)
			data.append('quad', generateQuadKey(item.x, item.y, item.z))
			data.append('outputDirectory', outputDirectory)
			data.append('outputFile', outputFile)
			data.append('outputType', outputType)
			data.append('outputScale', outputScale)
			data.append('timestamp', timestamp)
			data.append('source', source)
			data.append('bounds', boundsArray.join(","))
			data.append('center', centerArray.join(","))

			var request = $.ajax({
				"url": url,
				async: true,
				timeout: 30 * 1000,
				type: "post",
			    contentType: false,
			    processData: false,
				data: data,
				dataType: 'json',
			}).done(function(data) {

				if(cancellationToken) {
					return;
				}

				if(data.code == 200) {
					showTinyTile(data.image)
					logItem(item.x, item.y, item.z, data.message);
				} else {
					logItem(item.x, item.y, item.z, data.code + " Error downloading tile");
				}

			}).fail(function(data, textStatus, errorThrown) {

				if(cancellationToken) {
					return;
				}

				logItem(item.x, item.y, item.z, "Error while relaying tile");
				//allTiles.push(item);

			}).always(function(data) {
				i++;

				removeLayer(boxLayer);
				updateProgress(i, allTiles.length);

				done();
				
				if(cancellationToken) {
					return;
				}
			});

			requests.push(request);

		}, async function(err) {

			var request = await $.ajax({
				url: "/end-download",
				async: true,
				timeout: 30 * 1000,
				type: "post",
				contentType: false,
				processData: false,
				data: data,
				dataType: 'json',
			})

			updateProgress(allTiles.length, allTiles.length);
			logItemRaw("All requests are done");

			$("#stop-button").html("FINISH");
		});

	}

	function updateProgress(value, total) {
		var progress = value / total;

		bar.animate(progress);
		bar.setText(Math.round(progress * 100) + '<span>%</span>');

		$("#progress-subtitle").html(value.toLocaleString() + " <span>out of</span> " + total.toLocaleString())
	}

	function logItem(x, y, z, text) {
		logItemRaw(x + ',' + y + ',' + z + ' : ' + text)
	}

	function logItemRaw(text) {

		var logger = $('#log-view');
		logger.val(logger.val() + '\n' + text);

		logger.scrollTop(logger[0].scrollHeight);
	}

	function clearLogs() {
		var logger = $('#log-view');
		logger.val('');
	}

	function stopDownloading() {
		cancellationToken = true;

		for(var i =0 ; i < requests.length; i++) {
			var request = requests[i];
			try {
				request.abort();
			} catch(e) {

			}
		}

		$("#main-sidebar").show();
		$("#download-sidebar").hide();
		removeGrid();
		clearLogs();

	}

	initializeMaterialize();
	initializeSources();
	initializeMap();
	initializeSearch();
	initializeRectangleTool();
	initializeGridPreview();
	initializeMoreOptions();
	initializeDownloader();
});
