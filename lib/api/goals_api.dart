import '../api/http_client.dart';

class GoalsApi {
  final HttpClient client;
  GoalsApi(this.client);

  Future<Map<String, dynamic>> monthly({required String distributorCode, String? month}) {
    return client.get("/goals/monthly", query: {
      "distributorCode": distributorCode,
      if (month != null) "month": month,
    });
  }
}
