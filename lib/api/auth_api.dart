import 'dart:convert';
import '../api/http_client.dart';

class AuthApi {
  final HttpClient client;
  AuthApi(this.client);

  // IMPORTANT: your router is POST "/login" (mounted prefix may be /auth)
  // If your server mounts auth router at /auth => use "/auth/login"
  // If direct => use "/login"
  static const String loginPath = "/auth/login"; // change to "/login" if needed

  Future<Map<String, dynamic>> login({
    required String mobile,
    required String password,
  }) async {
    final res = await client.post(
      loginPath,
      auth: false,
      body: {"mobile": mobile, "password": password},
    );

    final token = (res["token"] ?? "").toString();
    if (token.isEmpty) throw ApiException("Token not found in login response");

    return res; // {message, token, user}
  }

  // helper to store user json if you want
  static String userToJson(Map<String, dynamic> res) {
    final user = (res["user"] ?? {}) as Map;
    return jsonEncode(user);
  }
}
