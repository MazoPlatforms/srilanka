package com.srilanka.map

import android.util.Log
import org.maplibre.android.geometry.LatLng
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * TileServerClient
 *
 * Lightweight HTTP client for the Sri Lanka tile server API.
 * Uses only java.net (no Retrofit/OkHttp dependency required).
 * For production apps, replace with OkHttp or Retrofit for connection pooling.
 *
 * All network calls are blocking — call from a background thread or coroutine.
 *
 * Usage (Kotlin coroutines):
 * ```kotlin
 * val client = TileServerClient(MapConfig.local())
 * val index = client.getStreetsIndex()
 * val places = client.searchPlaces("Colombo Fort", limit = 5)
 * ```
 */
class TileServerClient(private val config: MapConfig) {

    companion object {
        private const val TAG = "TileServerClient"
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val READ_TIMEOUT_MS = 15_000
    }

    // -----------------------------------------------------------------------
    // Streets API
    // -----------------------------------------------------------------------

    /** Fetch the master streets index JSON. */
    fun getStreetsIndex(): JSONObject? =
        getJson(config.streetsIndexUrl)

    /** Fetch data for a specific road class. */
    fun getStreetClass(roadClass: String): JSONObject? =
        getJson(config.streetClassUrl(roadClass))

    /** Fetch street data for a specific district. */
    fun getStreetDistrict(district: String): JSONObject? =
        getJson(config.streetDistrictUrl(district))

    // -----------------------------------------------------------------------
    // Routing API
    // -----------------------------------------------------------------------

    /** Fetch the routing manifest. */
    fun getRoutingManifest(): JSONObject? =
        getJson(config.routingManifestUrl)

    /** Fetch a specific routing cell by ID. */
    fun getRoutingCell(cellId: String): JSONObject? =
        getJson(config.routingCellUrl(cellId))

    /**
     * Compute a route from [start] to [end] using the given travel [mode].
     *
     * This implementation calls the tile server's routing endpoint which
     * wraps the client-side A* engine data. The actual pathfinding is
     * performed by loading the relevant routing cells.
     */
    fun getRoute(
        start: LatLng,
        end: LatLng,
        mode: String = "car",
    ): SriLankaMapHelper.RouteResult? {
        val url = buildString {
            append(config.routingEndpoint)
            append("/route.json?")
            append("from=${start.longitude},${start.latitude}")
            append("&to=${end.longitude},${end.latitude}")
            append("&mode=${URLEncoder.encode(mode, "UTF-8")}")
        }
        val json = getJson(url) ?: return null
        return try {
            val coordsArr = json.getJSONArray("coordinates")
            val coords = (0 until coordsArr.length()).map { i ->
                val pt = coordsArr.getJSONArray(i)
                Pair(pt.getDouble(0), pt.getDouble(1))
            }
            SriLankaMapHelper.RouteResult(
                coordinates = coords,
                distanceKm = json.optDouble("distance_km", 0.0),
                durationMin = json.optDouble("duration_min", 0.0),
                mode = mode,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse route response", e)
            null
        }
    }

    // -----------------------------------------------------------------------
    // Search API
    // -----------------------------------------------------------------------

    /**
     * Search for places matching [query].
     * Fetches the appropriate shard JSON from the tile server and filters locally.
     */
    fun searchPlaces(
        query: String,
        limit: Int = 8,
    ): List<SriLankaMapHelper.SearchResult> {
        val tokens = query.lowercase().trim().split(Regex("[\\s,.;:()\\[\\]/\\\\\\-_&'\"]+"))
            .filter { it.length >= 2 }
        val lead = tokens.firstOrNull() ?: return emptyList()

        // Derive shard key from first 2 Unicode code-points (matches build script)
        val codePoints = lead.codePoints().limit(2).toArray()
        if (codePoints.size < 2) return emptyList()
        val shardKey = codePoints.joinToString("-") { it.toString(16) }

        val shardUrl = "${config.tileServerBaseUrl}/data/search/$shardKey.json"
        val raw = getString(shardUrl) ?: return emptyList()

        return try {
            val arr = JSONArray(raw)
            val results = mutableListOf<SriLankaMapHelper.SearchResult>()
            for (i in 0 until arr.length()) {
                val row = arr.getJSONArray(i)
                val name = row.getString(0)
                val nameLower = name.lowercase()
                if (tokens.all { nameLower.contains(it) }) {
                    results.add(
                        SriLankaMapHelper.SearchResult(
                            name = name,
                            longitude = row.getDouble(1),
                            latitude = row.getDouble(2),
                            id = row.getString(3),
                            district = row.getInt(5),
                        )
                    )
                }
                if (results.size >= limit) break
            }
            results
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse search shard $shardKey", e)
            emptyList()
        }
    }

    // -----------------------------------------------------------------------
    // TileJSON
    // -----------------------------------------------------------------------

    /** Fetch combined TileJSON for all districts. */
    fun getCombinedTileJson(): JSONObject? =
        getJson(config.combinedTileJsonUrl)

    /** Fetch TileJSON for a specific district. */
    fun getTileJson(district: String): JSONObject? =
        getJson(config.tileJsonUrlFor(district))

    // -----------------------------------------------------------------------
    // Health
    // -----------------------------------------------------------------------

    /** Check if the tile server is reachable. */
    fun isHealthy(): Boolean {
        val json = getJson("${config.tileServerBaseUrl}/health") ?: return false
        return json.optString("status") == "ok"
    }

    // -----------------------------------------------------------------------
    // HTTP helpers
    // -----------------------------------------------------------------------

    private fun getJson(urlStr: String): JSONObject? {
        val body = getString(urlStr) ?: return null
        return try {
            JSONObject(body)
        } catch (e: Exception) {
            Log.e(TAG, "JSON parse error for $urlStr", e)
            null
        }
    }

    private fun getString(urlStr: String): String? {
        return try {
            val conn = URL(urlStr).openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "SriLankaMapSDK/1.0 Android")
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "HTTP ${conn.responseCode} for $urlStr")
                conn.disconnect()
                return null
            }
            val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
                .readText()
            conn.disconnect()
            body
        } catch (e: Exception) {
            Log.e(TAG, "Network error for $urlStr: ${e.message}")
            null
        }
    }
}
