package com.srilanka.map

import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression.*
import org.maplibre.android.style.layers.*
import org.maplibre.android.style.layers.PropertyFactory.*
import org.maplibre.android.style.sources.TileSet
import org.maplibre.android.style.sources.VectorSource
import android.content.Context
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL

/**
 * SriLankaMapHelper
 *
 * High-level helper that initialises a MapLibre Android map with Sri Lanka
 * vector tile sources, street layers, and routing integration.
 *
 * Usage:
 * ```kotlin
 * val helper = SriLankaMapHelper(context, mapView, MapConfig.local())
 * mapView.getMapAsync { map ->
 *     helper.setup(map) {
 *         helper.showStreets(listOf("motorway", "primary"))
 *     }
 * }
 * ```
 */
class SriLankaMapHelper(
    private val context: Context,
    private val mapView: MapView,
    private val config: MapConfig = MapConfig(),
) {

    companion object {
        private const val SOURCE_PREFIX = "sl_"
        private const val LAYER_ROAD_CASING = "sl-road-casing"

        /** Road class → hex colour */
        val CLASS_COLORS = mapOf(
            "motorway"     to "#ee4444",
            "trunk"        to "#ff8800",
            "primary"      to "#f6cf8a",
            "secondary"    to "#ffffdd",
            "tertiary"     to "#ffffee",
            "residential"  to "#ffffff",
            "living_street"to "#dddddd",
            "unclassified" to "#cccccc",
            "service"      to "#bbbbbb",
            "pedestrian"   to "#aaaaaa",
            "footway"      to "#999999",
            "steps"        to "#888888",
            "path"         to "#777777",
            "cycleway"     to "#66aaff",
            "bridleway"    to "#aa8844",
            "track"        to "#996644",
            "ferry"        to "#00aaff",
            "unknown"      to "#cccccc",
        )

        /** Road class → line width at zoom 14 */
        val CLASS_WIDTHS = mapOf(
            "motorway" to 7f, "trunk" to 6f, "primary" to 5f,
            "secondary" to 4f, "tertiary" to 3f,
        )
    }

    private var mapLibreMap: MapLibreMap? = null
    private val activeLayerIds = mutableSetOf<String>()
    private val client = TileServerClient(config)

    // -----------------------------------------------------------------------
    // Setup
    // -----------------------------------------------------------------------

    /**
     * Initialise the map with Sri Lanka style, sources, and default layers.
     *
     * @param map       The [MapLibreMap] instance from [MapView.getMapAsync].
     * @param onReady   Callback invoked on the main thread once the style is loaded.
     */
    fun setup(map: MapLibreMap, onReady: (() -> Unit)? = null) {
        mapLibreMap = map

        map.setStyle(config.styleUrl) { style ->
            configureCamera(map)
            addDistrictSources(style)
            addDefaultLayers(style)
            onReady?.invoke()
        }
    }

    private fun configureCamera(map: MapLibreMap) {
        val bounds = LatLngBounds.Builder()
            .include(LatLng(MapConfig.BBOX[3], MapConfig.BBOX[2]))
            .include(LatLng(MapConfig.BBOX[1], MapConfig.BBOX[0]))
            .build()
        map.setLatLngBoundsForCameraTarget(bounds)
        map.cameraPosition = CameraPosition.Builder()
            .target(LatLng(config.defaultCenter[1], config.defaultCenter[0]))
            .zoom(config.defaultZoom)
            .build()
        map.setMinZoomPreference(config.minZoom)
        map.setMaxZoomPreference(config.maxZoom)
    }

    private fun addDistrictSources(style: Style) {
        for (district in MapConfig.DISTRICTS) {
            val sourceId = "$SOURCE_PREFIX$district"
            if (style.getSource(sourceId) != null) continue
            val tileSet = TileSet("2.2.0", config.tileUrlFor(district)).apply {
                minZoom = 0f; maxZoom = 14f
                attribution = "© Overture Maps Foundation"
            }
            style.addSource(VectorSource(sourceId, tileSet))
        }
    }

    private fun addDefaultLayers(style: Style) {
        for (district in MapConfig.DISTRICTS) {
            val src = "$SOURCE_PREFIX$district"
            // Road casing (outline)
            val casingId = "sl-casing-$district"
            if (style.getLayer(casingId) == null) {
                style.addLayer(LineLayer(casingId, src).apply {
                    sourceLayer = "segment"
                    setFilter(eq(get("subtype"), literal("road")))
                    setProperties(
                        lineCap(Property.LINE_CAP_ROUND),
                        lineJoin(Property.LINE_JOIN_ROUND),
                        lineColor("#b7beb2"),
                        lineWidth(interpolate(linear(), zoom(), stop(8f, 0.4f), stop(14f, 3f))),
                    )
                })
            }
        }
        // Add major road fill layers on top
        addMajorRoadLayers(style)
    }

    private fun addMajorRoadLayers(style: Style) {
        val majorClasses = listOf("motorway", "trunk", "primary", "secondary", "tertiary")
        for (cls in majorClasses) {
            addStreetLayerInternal(style, cls)
        }
    }

    // -----------------------------------------------------------------------
    // Public API: Street layers
    // -----------------------------------------------------------------------

    /**
     * Show (or add) layers for the given road classes.
     *
     * @param classes List of road class strings from [MapConfig.ROAD_CLASSES].
     */
    fun showStreets(classes: List<String>) {
        val style = mapLibreMap?.style ?: return
        for (cls in classes) {
            addStreetLayerInternal(style, cls)
            // Make visible if already added
            for (district in MapConfig.DISTRICTS) {
                style.getLayer("sl-$cls-$district")
                    ?.setProperties(visibility(Property.VISIBLE))
            }
        }
    }

    /**
     * Hide layers for the given road classes without removing them.
     */
    fun hideStreets(classes: List<String>) {
        val style = mapLibreMap?.style ?: return
        for (cls in classes) {
            for (district in MapConfig.DISTRICTS) {
                style.getLayer("sl-$cls-$district")
                    ?.setProperties(visibility(Property.NONE))
            }
        }
    }

    /**
     * Add a street layer for a specific road [cls] across all districts.
     */
    fun addStreetLayer(map: MapLibreMap, cls: String) {
        mapLibreMap = map
        map.getStyle { style -> addStreetLayerInternal(style, cls) }
    }

    private fun addStreetLayerInternal(style: Style, cls: String) {
        val color = CLASS_COLORS[cls] ?: "#cccccc"
        val width = CLASS_WIDTHS[cls] ?: 2f
        for (district in MapConfig.DISTRICTS) {
            val layerId = "sl-$cls-$district"
            if (style.getLayer(layerId) != null) continue
            val src = "$SOURCE_PREFIX$district"
            val layer = LineLayer(layerId, src).apply {
                sourceLayer = "segment"
                setFilter(all(
                    eq(get("subtype"), literal("road")),
                    eq(get("class"), literal(cls)),
                ))
                setProperties(
                    lineCap(Property.LINE_CAP_ROUND),
                    lineJoin(Property.LINE_JOIN_ROUND),
                    lineColor(color),
                    lineWidth(interpolate(linear(), zoom(),
                        stop(8f, 0.2f), stop(14f, width))),
                )
            }
            style.addLayer(layer)
            activeLayerIds.add(layerId)
        }
    }

    // -----------------------------------------------------------------------
    // Public API: Search
    // -----------------------------------------------------------------------

    /**
     * Search for places by name. Returns up to [limit] results.
     *
     * Results are fetched from the search shard JSON files produced by the
     * build pipeline and served from `public/data/search/`.
     *
     * @param query  Search query string.
     * @param limit  Maximum number of results (default 8).
     * @return List of [SearchResult] objects.
     */
    suspend fun searchPlaces(query: String, limit: Int = 8): List<SearchResult> =
        withContext(Dispatchers.IO) {
            client.searchPlaces(query, limit)
        }

    // -----------------------------------------------------------------------
    // Public API: Routing
    // -----------------------------------------------------------------------

    /**
     * Request a route between two points using the A* engine.
     *
     * @param start  [LatLng] origin.
     * @param end    [LatLng] destination.
     * @param mode   Travel mode: "car", "motorcycle", "truck", "bus", "bike", "walk".
     * @return [RouteResult] with the path geometry and metadata, or null on failure.
     */
    suspend fun getRoute(start: LatLng, end: LatLng, mode: String = "car"): RouteResult? =
        withContext(Dispatchers.IO) {
            client.getRoute(start, end, mode)
        }

    /**
     * Render a [RouteResult] as a polyline layer on the map.
     */
    fun drawRoute(route: RouteResult) {
        val style = mapLibreMap?.style ?: return
        // Remove previous route
        clearRoute()
        // Build GeoJSON LineString
        val coords = JSONArray()
        for ((lon, lat) in route.coordinates) {
            coords.put(JSONArray().put(lon).put(lat))
        }
        val geojson = JSONObject()
            .put("type", "FeatureCollection")
            .put("features", JSONArray().put(
                JSONObject()
                    .put("type", "Feature")
                    .put("geometry", JSONObject()
                        .put("type", "LineString")
                        .put("coordinates", coords))
                    .put("properties", JSONObject())))

        val srcId = "sl-route-src"
        val layId = "sl-route-layer"
        style.removeLayer(layId)
        style.removeSource(srcId)
        style.addSource(org.maplibre.android.style.sources.GeoJsonSource(srcId, geojson.toString()))
        style.addLayer(LineLayer(layId, srcId).apply {
            setProperties(
                lineColor("#007aff"),
                lineWidth(5f),
                lineCap(Property.LINE_CAP_ROUND),
                lineJoin(Property.LINE_JOIN_ROUND),
            )
        })
    }

    /** Remove the current route polyline from the map. */
    fun clearRoute() {
        val style = mapLibreMap?.style ?: return
        style.removeLayer("sl-route-layer")
        style.removeSource("sl-route-src")
    }

    // -----------------------------------------------------------------------
    // Data classes
    // -----------------------------------------------------------------------

    data class SearchResult(
        val name: String,
        val longitude: Double,
        val latitude: Double,
        val id: String,
        val district: Int,
    )

    data class RouteResult(
        val coordinates: List<Pair<Double, Double>>,
        val distanceKm: Double,
        val durationMin: Double,
        val mode: String,
    )
}
