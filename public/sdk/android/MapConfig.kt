package com.srilanka.map

/**
 * Configuration for the Sri Lanka Map tile server and SDK.
 *
 * @param tileServerBaseUrl  Base URL of the tile server (e.g. "http://192.168.1.1:8080")
 * @param styleUrl           MapLibre GL style JSON URL served by the tile server
 * @param routingEndpoint    Base URL for routing requests
 * @param searchEndpoint     Base URL for place-search requests
 * @param maxZoom            Maximum zoom level for vector tiles (default 14)
 * @param minZoom            Minimum allowed map zoom (default 6)
 * @param defaultCenter      Initial map centre [longitude, latitude]
 * @param defaultZoom        Initial map zoom level
 * @param enableBuildings    Show 3-D building extrusions when zoomed in
 * @param enableRouting      Activate the A* routing integration
 */
data class MapConfig(
    val tileServerBaseUrl: String = "http://localhost:8080",
    val styleUrl: String = "$tileServerBaseUrl/style.json",
    val routingEndpoint: String = "$tileServerBaseUrl/routing",
    val searchEndpoint: String = "$tileServerBaseUrl/streets",
    val maxZoom: Double = 14.0,
    val minZoom: Double = 6.0,
    val defaultCenter: DoubleArray = doubleArrayOf(80.7, 7.87),
    val defaultZoom: Double = 8.0,
    val enableBuildings: Boolean = true,
    val enableRouting: Boolean = true,
) {
    /** Tile template URL for a specific district. */
    fun tileUrlFor(district: String): String =
        "$tileServerBaseUrl/tiles/$district/{z}/{x}/{y}.pbf"

    /** TileJSON URL for a specific district. */
    fun tileJsonUrlFor(district: String): String =
        "$tileServerBaseUrl/tilejson/$district.json"

    /** Combined TileJSON URL for all districts. */
    val combinedTileJsonUrl: String
        get() = "$tileServerBaseUrl/tilejson.json"

    /** Streets index URL. */
    val streetsIndexUrl: String
        get() = "$tileServerBaseUrl/streets/index.json"

    /** URL for a specific street-class JSON. */
    fun streetClassUrl(roadClass: String): String =
        "$tileServerBaseUrl/streets/by-class/$roadClass.json"

    /** URL for a specific district streets JSON. */
    fun streetDistrictUrl(district: String): String =
        "$tileServerBaseUrl/streets/by-district/$district.json"

    /** Routing manifest URL. */
    val routingManifestUrl: String
        get() = "$routingEndpoint/manifest.json"

    /** URL for a specific routing cell JSON. */
    fun routingCellUrl(cellId: String): String =
        "$routingEndpoint/$cellId.json"

    companion object {
        /** Sri Lanka bounding box [west, south, east, north]. */
        val BBOX: DoubleArray = doubleArrayOf(79.4, 5.8, 82.0, 9.95)

        /** All known road classes. */
        val ROAD_CLASSES: List<String> = listOf(
            "motorway", "trunk", "primary", "secondary", "tertiary",
            "residential", "living_street", "unclassified", "service",
            "pedestrian", "footway", "steps", "path", "cycleway",
            "bridleway", "track", "ferry", "unknown",
        )

        /** Official district slugs (matches tile server). */
        val DISTRICTS: List<String> = listOf(
            "ampara", "anuradhapura", "badulla", "batticaloa", "colombo",
            "galle", "gampaha", "hambantota", "jaffna", "kalutara",
            "kandy", "kegalle", "kilinochchi", "kurunegala", "mannar",
            "matale", "matara", "monaragala", "mullaitivu", "nuwara-eliya",
            "polonnaruwa", "puttalam", "ratnapura", "trincomalee", "vavuniya",
        )

        /** Default production config pointing to a hosted tile server. */
        fun production(tileServerBaseUrl: String): MapConfig =
            MapConfig(tileServerBaseUrl = tileServerBaseUrl)

        /** Local development config. */
        fun local(port: Int = 8080): MapConfig =
            MapConfig(tileServerBaseUrl = "http://10.0.2.2:$port")  // Android emulator host
    }
}
