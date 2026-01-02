import '../api/http_client.dart';
import '../config/api_config.dart';

class TripsApi {
  final HttpClient client;
  TripsApi(this.client);

  Future<Map<String, dynamic>> listTrips() => client.get(ApiConfig.trips);

  Future<Map<String, dynamic>> tripDetails(String tripId) =>
      client.get("${ApiConfig.trips}/$tripId");

  Future<Map<String, dynamic>> updateTripStatus(String tripId, Map<String, dynamic> patch) =>
      client.patch("${ApiConfig.trips}/$tripId/status", body: patch);
}
