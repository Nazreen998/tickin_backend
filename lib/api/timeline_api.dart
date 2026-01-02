import '../api/http_client.dart';
import '../config/api_config.dart';

class TimelineApi {
  final HttpClient client;
  TimelineApi(this.client);

  Future<Map<String, dynamic>> getTimeline(String orderId) {
    return client.get("${ApiConfig.timeline}/$orderId");
  }
}
